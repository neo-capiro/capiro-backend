import { Controller, Get } from '@nestjs/common';

/**
 * Unauthenticated boot config for the onboard-web SPA (fetched before Clerk
 * loads, so it cannot carry a token). Only publishable/public values — never
 * secrets.
 */
@Controller('public/config')
export class PublicConfigController {
  @Get()
  config(): {
    clerkPublishableKey: string | null;
    stripePublishableKey: string | null;
    appBaseUrl: string;
    apiBaseUrl: string;
    onboardingBaseUrl: string;
    funnelEnabled: boolean;
    environment: string;
  } {
    return {
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? null,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
      appBaseUrl: process.env.ONBOARD_APP_BASE_URL ?? 'https://app.capiro.ai',
      apiBaseUrl: process.env.ONBOARD_API_PUBLIC_BASE_URL ?? 'https://app.capiro.ai',
      onboardingBaseUrl: process.env.ONBOARD_PUBLIC_BASE_URL ?? 'https://onboarding.capiro.ai',
      funnelEnabled: (process.env.ONBOARD_FUNNEL_ENABLED ?? 'false') === 'true',
      environment: process.env.CAPIRO_ENV ?? 'dev',
    };
  }
}
