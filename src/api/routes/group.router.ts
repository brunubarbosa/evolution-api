import { RouterBroker } from '@api/abstract/abstract.router';
import {
  AcceptGroupInvite,
  CreateGroupDto,
  GetParticipant,
  // [GDW-004] Join-request action DTOs
  GroupAcceptInviteV4Dto,
  GroupDescriptionDto,
  // [GDW-008] Group events query DTO
  GroupEventsQueryDto,
  GroupInvite,
  GroupJid,
  GroupJoinApprovalModeDto,
  GroupMemberAddModeDto,
  GroupPictureDto,
  GroupRevokeInviteV4Dto,
  GroupSendInvite,
  GroupSubjectDto,
  GroupToggleEphemeralDto,
  GroupUpdateParticipantDto,
  GroupUpdatePendingRequestsDto,
  GroupUpdateSettingDto,
} from '@api/dto/group.dto';
// [GDW-008] InstanceDto type for the GET /group/events handler.
import { InstanceDto } from '@api/dto/instance.dto';
import { groupController } from '@api/server.module';
import {
  AcceptGroupInviteSchema,
  createGroupSchema,
  getParticipantsSchema,
  groupInviteSchema,
  groupJidSchema,
  groupSendInviteSchema,
  toggleEphemeralSchema,
  updateGroupDescriptionSchema,
  updateGroupPictureSchema,
  updateGroupSubjectSchema,
  updateParticipantsSchema,
  updateSettingsSchema,
} from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class GroupRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CreateGroupDto>({
          request: req,
          schema: createGroupSchema,
          ClassRef: CreateGroupDto,
          execute: (instance, data) => groupController.createGroup(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateGroupSubject'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupSubjectDto>({
          request: req,
          schema: updateGroupSubjectSchema,
          ClassRef: GroupSubjectDto,
          execute: (instance, data) => groupController.updateGroupSubject(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateGroupPicture'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupPictureDto>({
          request: req,
          schema: updateGroupPictureSchema,
          ClassRef: GroupPictureDto,
          execute: (instance, data) => groupController.updateGroupPicture(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateGroupDescription'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupDescriptionDto>({
          request: req,
          schema: updateGroupDescriptionSchema,
          ClassRef: GroupDescriptionDto,
          execute: (instance, data) => groupController.updateGroupDescription(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('findGroupInfos'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: groupJidSchema,
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.findGroupInfo(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('fetchAllGroups'), ...guards, async (req, res) => {
        const response = await this.getParticipantsValidate<GetParticipant>({
          request: req,
          schema: getParticipantsSchema,
          ClassRef: GetParticipant,
          execute: (instance, data) => groupController.fetchAllGroups(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('participants'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: groupJidSchema,
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.findParticipants(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('inviteCode'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: groupJidSchema,
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.inviteCode(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('inviteInfo'), ...guards, async (req, res) => {
        const response = await this.inviteCodeValidate<GroupInvite>({
          request: req,
          schema: groupInviteSchema,
          ClassRef: GroupInvite,
          execute: (instance, data) => groupController.inviteInfo(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .get(this.routerPath('acceptInviteCode'), ...guards, async (req, res) => {
        const response = await this.inviteCodeValidate<AcceptGroupInvite>({
          request: req,
          schema: AcceptGroupInviteSchema,
          ClassRef: AcceptGroupInvite,
          execute: (instance, data) => groupController.acceptInviteCode(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('sendInvite'), ...guards, async (req, res) => {
        const response = await this.groupNoValidate<GroupSendInvite>({
          request: req,
          schema: groupSendInviteSchema,
          ClassRef: GroupSendInvite,
          execute: (instance, data) => groupController.sendInvite(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('revokeInviteCode'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: groupJidSchema,
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.revokeInviteCode(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateParticipant'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupUpdateParticipantDto>({
          request: req,
          schema: updateParticipantsSchema,
          ClassRef: GroupUpdateParticipantDto,
          execute: (instance, data) => groupController.updateGParticipate(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateSetting'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupUpdateSettingDto>({
          request: req,
          schema: updateSettingsSchema,
          ClassRef: GroupUpdateSettingDto,
          execute: (instance, data) => groupController.updateGSetting(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('toggleEphemeral'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupToggleEphemeralDto>({
          request: req,
          schema: toggleEphemeralSchema,
          ClassRef: GroupToggleEphemeralDto,
          execute: (instance, data) => groupController.toggleEphemeral(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .delete(this.routerPath('leaveGroup'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: {},
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.leaveGroup(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      // ─── [GDW-004] Join-request action routes ────────────────────────────
      // Closes the loop with GDW-002 (join-request capture). Routes are
      // always registered (never gated by env vars); inert if not called.
      .post(this.routerPath('acceptInviteV4'), ...guards, async (req, res) => {
        const response = await this.dataValidate<GroupAcceptInviteV4Dto>({
          request: req,
          schema: {},
          ClassRef: GroupAcceptInviteV4Dto,
          execute: (instance, data) => groupController.acceptInviteV4(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('revokeInviteV4'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupRevokeInviteV4Dto>({
          request: req,
          schema: {},
          ClassRef: GroupRevokeInviteV4Dto,
          execute: (instance, data) => groupController.revokeInviteV4(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateMemberAddMode'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupMemberAddModeDto>({
          request: req,
          schema: {},
          ClassRef: GroupMemberAddModeDto,
          execute: (instance, data) => groupController.updateMemberAddMode(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .post(this.routerPath('updateJoinApprovalMode'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJoinApprovalModeDto>({
          request: req,
          schema: {},
          ClassRef: GroupJoinApprovalModeDto,
          execute: (instance, data) => groupController.updateJoinApprovalMode(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('pendingJoinRequests'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupJid>({
          request: req,
          schema: groupJidSchema,
          ClassRef: GroupJid,
          execute: (instance, data) => groupController.pendingJoinRequests(instance, data),
        });

        res.status(HttpStatus.OK).json(response);
      })
      .post(this.routerPath('updatePendingJoinRequests'), ...guards, async (req, res) => {
        const response = await this.groupValidate<GroupUpdatePendingRequestsDto>({
          request: req,
          schema: {},
          ClassRef: GroupUpdatePendingRequestsDto,
          execute: (instance, data) => groupController.updatePendingJoinRequests(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      // ─── [GDW-008] Group event audit trail query ────────────────────────
      // GET /group/events/:instanceName?groupJid=X&since=ISO&type=X&limit=N
      // Always available — returns [] when persistence is disabled or no
      // matching rows exist. See PATCHES.md GDW-008.
      .get(this.routerPath('events'), ...guards, async (req, res) => {
        const instance = req.params as unknown as InstanceDto;
        const query: GroupEventsQueryDto = new GroupEventsQueryDto();
        const q = (req.query ?? {}) as Record<string, string | undefined>;
        let groupJid = q.groupJid;
        if (!groupJid) {
          res.status(HttpStatus.BAD_REQUEST).json({
            status: HttpStatus.BAD_REQUEST,
            error: 'Bad Request',
            message: 'groupJid query param is required',
          });
          return;
        }
        if (!groupJid.endsWith('@g.us')) groupJid = groupJid + '@g.us';
        query.groupJid = groupJid;
        if (q.since) query.since = q.since;
        if (q.type) query.type = q.type;
        if (q.limit) query.limit = Number(q.limit);

        const response = await groupController.findGroupEvents(instance, query);
        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
