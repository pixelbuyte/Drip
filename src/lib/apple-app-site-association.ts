/**
 * The apple-app-site-association document served at
 * `/.well-known/apple-app-site-association` (route:
 * src/app/.well-known/apple-app-site-association/route.ts). iOS fetches it
 * (through Apple's CDN) when the app is installed and opens matching https
 * links in the app instead of Safari — universal links.
 *
 * App ID = `<Apple Team ID>.<bundle id>`. The Team ID is not committed: it
 * comes from the `APPLE_TEAM_ID` env var (Vercel project settings). While it
 * is unset — or not a 10-character Team ID — the route answers 404, which
 * iOS treats as "no association": links keep opening the website, nothing
 * breaks. Serving a placeholder App ID instead would be cached by Apple's
 * CDN and silently fail to associate.
 */

/** ios/Config/Shared.xcconfig DRIP_BUNDLE_ID. */
export const IOS_BUNDLE_ID = 'com.pixelbuyte.drip';

/**
 * Paths the app claims. Only routes the website actually serves: a claimed
 * path with no web page would strand anyone without the app on a 404.
 * `/v/<videoId>` is the shareable per-video page (src/app/v/[videoId]).
 */
export const UNIVERSAL_LINK_PATHS = ['/v/*'] as const;

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

export type AppSiteAssociation = {
  applinks: {
    details: { appIDs: string[]; components: { '/': string; comment?: string }[] }[];
  };
};

export function buildAppSiteAssociation(teamId: string, bundleId: string = IOS_BUNDLE_ID): AppSiteAssociation {
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.${bundleId}`],
          components: UNIVERSAL_LINK_PATHS.map((p) => ({ '/': p, comment: 'Shared video' })),
        },
      ],
    },
  };
}

/** The document for this deployment, or null when APPLE_TEAM_ID is unset/invalid. */
export function appSiteAssociationFromEnv(
  env: Record<string, string | undefined> = process.env
): AppSiteAssociation | null {
  const teamId = env.APPLE_TEAM_ID?.trim().toUpperCase();
  if (!teamId || !TEAM_ID_RE.test(teamId)) return null;
  return buildAppSiteAssociation(teamId);
}
