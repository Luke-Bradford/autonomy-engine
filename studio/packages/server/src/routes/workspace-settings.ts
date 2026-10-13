import type { FastifyPluginAsync } from 'fastify';
import { WorkspaceSettingsPutBodySchema } from '@autonomy-studio/shared';
import { getWorkspaceSettings, putWorkspaceSettings } from '../repo/index.js';

/**
 * #1600 OR41 C0f — `GET/PUT /api/workspace/settings`, a workspace's own
 * settings. The first is the default Timeout a new execution activity is created
 * with (catalogue §3).
 *
 * Security model: both routes act on the caller's own row, keyed by
 * `request.principal.ownerId`. Nothing in the request names an owner, so there
 * is no other workspace's row to reach. The values are cleartext configuration,
 * returned as stored.
 */
export const workspaceSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/workspace/settings', async (request) =>
    getWorkspaceSettings(db, request.principal.ownerId),
  );

  fastify.put('/api/workspace/settings', async (request) => {
    const body = WorkspaceSettingsPutBodySchema.parse(request.body);
    return putWorkspaceSettings(db, request.principal.ownerId, body);
  });
};
