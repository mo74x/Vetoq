import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import { MAX_APPROVAL_BODY_BYTES } from '@hitl/shared';
import { AppModule } from './app.module.js';
import { BETTER_AUTH_TOKEN } from './auth/auth.guard.js';
import type { BetterAuthInstance } from './auth/auth.js';

async function bootstrap() {
  const rootEnv = path.resolve(process.cwd(), '../../.env');
  if (!process.env.DATABASE_URL && fs.existsSync(rootEnv)) {
    process.loadEnvFile(rootEnv);
  }
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const expressApp = app.getHttpAdapter().getInstance();
  const auth = app.get<BetterAuthInstance>(BETTER_AUTH_TOKEN);
  const authHandler = toNodeHandler(auth);

  // Mount Better Auth handler before JSON body parser so /api/auth/* handles raw stream
  expressApp.all('/api/auth/*splat', (req: Request, res: Response) => {
    return authHandler(req, res);
  });

  // Apply JSON + raw-body parser only to non-auth routes
  const jsonParser = express.json({
    limit: MAX_APPROVAL_BODY_BYTES,
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  });

  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/auth')) {
      return next();
    }
    return jsonParser(req, res, next);
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`@hitl/api listening on http://localhost:${port}`);
}

bootstrap();
