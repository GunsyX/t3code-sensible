import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const CHECK_INTERVAL = Duration.hours(6);
const STARTUP_DELAY = Duration.minutes(2);
// handoff-release.yml runs every 6 hours and takes about an hour, so a healthy rebuild lands inside this.
const REBUILD_GRACE = Duration.hours(8);

const UpstreamRelease = Schema.Struct({ tag_name: Schema.String, published_at: Schema.String });

const { logWarning } = DesktopObservability.makeComponentLogger("desktop-patched-build-alert");

export function parseFeedRepository(appUpdateYml: string): string | null {
  const owner = /^owner:\s*(\S+)\s*$/m.exec(appUpdateYml)?.[1];
  const repo = /^repo:\s*(\S+)\s*$/m.exec(appUpdateYml)?.[1];
  return owner && repo ? `${owner}/${repo}` : null;
}

export function isPatchedBuildOverdue(input: {
  readonly appVersion: string;
  readonly offeredVersion: string | null;
  readonly upstreamVersion: string;
  readonly upstreamAgeMillis: number;
}): boolean {
  const isCovered = (version: string | null) =>
    version !== null && compareSemverVersions(version, input.upstreamVersion) >= 0;
  return (
    !isCovered(input.appVersion) &&
    !isCovered(input.offeredVersion) &&
    input.upstreamAgeMillis >= Duration.toMillis(REBUILD_GRACE)
  );
}

/** Judged by outcome rather than a workflow signal, so a rebuild that never ran still alerts. */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopUpdates.DesktopUpdates
  | ElectronShell.ElectronShell
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const shell = yield* ElectronShell.ElectronShell;
  const fileSystem = yield* FileSystem.FileSystem;
  const httpClient = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<never>();

  const feedRepository = yield* fileSystem.readFileString(environment.appUpdateYmlPath).pipe(
    Effect.map(parseFeedRepository),
    Effect.orElseSucceed(() => null),
  );
  if (feedRepository === null || feedRepository === UPSTREAM_REPOSITORY) return;

  // Electron drops a notification's click handler once the object is collected.
  const shownNotification = yield* Ref.make(Option.none<Electron.Notification>());
  const alertedVersion = yield* Ref.make(Option.none<string>());

  const showAlert = (version: string) =>
    Effect.sync(() => {
      const notification = new Electron.Notification({
        title: "Handoff patch didn't rebuild",
        body: `T3 Code ${version} is out, but no patched build has arrived. Click to open the failed run.`,
      });
      notification.on("click", () => {
        void Effect.runPromiseWith(context)(
          shell.openExternal(
            `https://github.com/${feedRepository}/actions/workflows/handoff-release.yml`,
          ),
        );
      });
      notification.show();
      return notification;
    }).pipe(
      Effect.flatMap((notification) => Ref.set(shownNotification, Option.some(notification))),
    );

  const check = Effect.gen(function* () {
    const request = HttpClientRequest.get(
      `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/releases/latest`,
    ).pipe(
      // GitHub's API rejects requests without a User-Agent.
      HttpClientRequest.setHeaders({
        Accept: "application/vnd.github+json",
        "User-Agent": "t3code-desktop",
      }),
    );
    const release = yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(UpstreamRelease)),
      );
    const upstreamVersion = release.tag_name.replace(/^v/, "");
    const publishedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(release.published_at));
    const state = yield* updates.getState;
    const overdue = isPatchedBuildOverdue({
      appVersion: environment.appVersion,
      offeredVersion: state.downloadedVersion ?? state.availableVersion,
      upstreamVersion,
      upstreamAgeMillis: DateTime.toEpochMillis(yield* DateTime.now) - publishedAt,
    });
    if (!overdue) return;
    const alerted = yield* Ref.get(alertedVersion);
    if (Option.contains(alerted, upstreamVersion)) return;
    yield* Ref.set(alertedVersion, Option.some(upstreamVersion));
    yield* showAlert(upstreamVersion);
  }).pipe(
    // Being offline must not read as a failed rebuild.
    Effect.catchCause((cause) =>
      logWarning("could not check for an overdue patched build", {
        cause: DesktopUpdates.describeUpdateErrorCause(cause),
      }),
    ),
  );

  yield* Effect.sleep(STARTUP_DELAY).pipe(
    Effect.andThen(check),
    Effect.andThen(Effect.sleep(CHECK_INTERVAL)),
    Effect.forever,
    Effect.forkScoped,
  );
}).pipe(Effect.withSpan("desktop.patchedBuildAlert.listen"));
