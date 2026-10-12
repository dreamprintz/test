import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  BACKEND_API_KEY: z.string().min(24, 'BACKEND_API_KEY must be at least 24 characters'),
  ALLOWED_ORIGINS: z.string().default(''),
  DATA_DIR: z.string().default('./data'),
  META_ACCESS_TOKEN: z.string().default(''),
  META_PHONE_NUMBER_ID: z.string().regex(/^\d*$/, 'META_PHONE_NUMBER_ID must be numeric').default(''),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/, 'META_API_VERSION looks like v23.0').default('v23.0'),
  META_APP_SECRET: z.string().default(''),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  OPT_OUT_KEYWORDS: z.string().default('STOP,STOP ALL,UNSUBSCRIBE,OPT OUT,OPTOUT'),
});

export interface Config {
  port: number;
  apiKey: string;
  allowedOrigins: string[];
  dataDir: string;
  meta: { accessToken: string; phoneNumberId: string; apiVersion: string; appSecret: string; verifyToken: string };
  optOutKeywords: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    apiKey: e.BACKEND_API_KEY,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    dataDir: e.DATA_DIR,
    meta: { accessToken: e.META_ACCESS_TOKEN, phoneNumberId: e.META_PHONE_NUMBER_ID, apiVersion: e.META_API_VERSION, appSecret: e.META_APP_SECRET, verifyToken: e.META_WEBHOOK_VERIFY_TOKEN },
    optOutKeywords: e.OPT_OUT_KEYWORDS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  };
}

export const metaConfigured = (c: Config) => !!(c.meta.accessToken && c.meta.phoneNumberId);
