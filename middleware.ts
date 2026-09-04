import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextRequest, NextResponse } from 'next/server'

const isOnboardingRoute = createRouteMatcher(['/onboarding'])
const isPublicRoute = createRouteMatcher([
  '/public-route-example',
  '/api/telegram(.*)',
])

export default clerkMiddleware(async (auth, req: NextRequest) => {
  // Telegram webhooks must be publicly reachable by Telegram.
  // The webhook route performs its own secret-token verification.
  if (isPublicRoute(req)) return NextResponse.next()

  const { userId, sessionClaims, redirectToSignIn } = await auth()

  if (userId && isOnboardingRoute(req)) {
    return NextResponse.next()
  }

  if (!userId) return redirectToSignIn({ returnBackUrl: req.url })

  if (userId && !sessionClaims?.metadata?.onboardingComplete) {
    const onboardingUrl = new URL('/onboarding', req.url)
    return NextResponse.redirect(onboardingUrl)
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
