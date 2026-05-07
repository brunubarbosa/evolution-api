// [GDW-007] Community router — REST surface mirroring Baileys' communities.* API.
// Style mirrors `src/api/routes/group.router.ts`. Routes are always registered
// (never gated by env vars); they are inert if not called.

import { RouterBroker } from '@api/abstract/abstract.router';
import {
  CommunityAcceptInviteV4Dto,
  CommunityCreateDto,
  CommunityCreateGroupDto,
  CommunityDescriptionDto,
  CommunityInviteCode,
  CommunityJid,
  CommunityLinkGroupDto,
  CommunityRevokeInviteV4Dto,
  CommunitySubjectDto,
  CommunityUpdateParticipantsDto,
  CommunityUpdatePendingRequestsDto,
} from '@api/dto/community.dto';
import { communityController } from '@api/server.module';
import { BadRequestException } from '@exceptions';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

// Pull `communityJid` from query string into the request body for GET routes,
// and append the `@g.us` server suffix WhatsApp expects for community/group JIDs.
function ensureCommunityJid(req: any) {
  let communityJid = req.body?.communityJid ?? req.query?.communityJid;
  if (!communityJid) {
    throw new BadRequestException(
      'The community id needs to be informed in the body or query',
      'ex: "communityJid=120362@g.us"',
    );
  }
  if (!String(communityJid).endsWith('@g.us')) {
    communityJid = `${communityJid}@g.us`;
  }
  req.body = { ...(req.body ?? {}), communityJid };
}

// Pull `inviteCode` from query string for GET routes.
function ensureInviteCode(req: any) {
  const inviteCode = req.body?.inviteCode ?? req.query?.inviteCode;
  if (!inviteCode) {
    throw new BadRequestException(
      'The invite code needs to be informed in the body or query',
      'ex: "inviteCode=F1EX5QZxO181L3TMVP31gY"',
    );
  }
  req.body = { ...(req.body ?? {}), inviteCode };
}

export class CommunityRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .get(this.routerPath('metadata'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityMetadata(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CommunityCreateDto>({
          request: req,
          schema: {},
          ClassRef: CommunityCreateDto,
          execute: (instance, data) => communityController.communityCreate(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('createGroup'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CommunityCreateGroupDto>({
          request: req,
          schema: {},
          ClassRef: CommunityCreateGroupDto,
          execute: (instance, data) => communityController.communityCreateGroup(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .delete(this.routerPath('leave'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityLeave(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('updateSubject'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunitySubjectDto>({
          request: req,
          schema: {},
          ClassRef: CommunitySubjectDto,
          execute: (instance, data) => communityController.communityUpdateSubject(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateDescription'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityDescriptionDto>({
          request: req,
          schema: {},
          ClassRef: CommunityDescriptionDto,
          execute: (instance, data) => communityController.communityUpdateDescription(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('linkGroup'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CommunityLinkGroupDto>({
          request: req,
          schema: {},
          ClassRef: CommunityLinkGroupDto,
          execute: (instance, data) => communityController.communityLinkGroup(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('unlinkGroup'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CommunityLinkGroupDto>({
          request: req,
          schema: {},
          ClassRef: CommunityLinkGroupDto,
          execute: (instance, data) => communityController.communityUnlinkGroup(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('linkedGroups'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityFetchLinkedGroups(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('inviteCode'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityInviteCode(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('revokeInvite'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityRevokeInvite(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('acceptInvite'), ...guards, async (req, res) => {
        ensureInviteCode(req);
        const response = await this.dataValidate<CommunityInviteCode>({
          request: req,
          schema: {},
          ClassRef: CommunityInviteCode,
          execute: (instance, data) => communityController.communityAcceptInvite(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('acceptInviteV4'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CommunityAcceptInviteV4Dto>({
          request: req,
          schema: {},
          ClassRef: CommunityAcceptInviteV4Dto,
          execute: (instance, data) => communityController.communityAcceptInviteV4(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('revokeInviteV4'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityRevokeInviteV4Dto>({
          request: req,
          schema: {},
          ClassRef: CommunityRevokeInviteV4Dto,
          execute: (instance, data) => communityController.communityRevokeInviteV4(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('pendingRequests'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityJid>({
          request: req,
          schema: {},
          ClassRef: CommunityJid,
          execute: (instance, data) => communityController.communityRequestParticipantsList(instance, data),
        });
        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('updatePendingRequests'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityUpdatePendingRequestsDto>({
          request: req,
          schema: {},
          ClassRef: CommunityUpdatePendingRequestsDto,
          execute: (instance, data) => communityController.communityRequestParticipantsUpdate(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateParticipants'), ...guards, async (req, res) => {
        ensureCommunityJid(req);
        const response = await this.dataValidate<CommunityUpdateParticipantsDto>({
          request: req,
          schema: {},
          ClassRef: CommunityUpdateParticipantsDto,
          execute: (instance, data) => communityController.communityParticipantsUpdate(instance, data),
        });
        res.status(HttpStatus.CREATED).json(response);
      });
  }

  public readonly router: Router = Router();
}
