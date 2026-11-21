import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import express from 'express';
import request from 'supertest';
import { MAX_APPROVAL_BODY_BYTES } from '@hitl/shared';
import { AppModule } from '../src/app.module.js';

describe('HITL API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(express.json({ limit: MAX_APPROVAL_BODY_BYTES }));
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects unauthenticated POST /v1/approvals with 401', async () => {
    await request(app.getHttpServer())
      .post('/v1/approvals')
      .send({
        action_type: 'stripe.refund',
        title: 'Test',
        callback_url: 'https://example.com/hook',
        payload: { amount: 100 },
      })
      .expect(401);
  });
});
