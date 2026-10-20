import { appSiteAssociationFromEnv } from '@/lib/apple-app-site-association';

// Read at request time: APPLE_TEAM_ID is a deployment env var, and a build
// made before it was set must not bake in the 404.
export const dynamic = 'force-dynamic';

/**
 * GET /.well-known/apple-app-site-association — universal links for the iOS
 * app. Served as JSON at this exact path (no .json extension, no redirect),
 * which is what Apple's CDN requires. 404 until the APPLE_TEAM_ID env var is
 * set to the Apple Developer Team ID; see src/lib/apple-app-site-association.ts.
 */
export function GET() {
  const body = appSiteAssociationFromEnv();
  if (!body) return new Response('Not Found', { status: 404 });
  return Response.json(body, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}
