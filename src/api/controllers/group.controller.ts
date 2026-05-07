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
import { InstanceDto } from '@api/dto/instance.dto';
// [GDW-008] PrismaRepository for group events query.
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';

export class GroupController {
  // [GDW-008] prismaRepository is optional so existing test/wiring callers
  // that only pass waMonitor still compile. server.module.ts wires both.
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository?: PrismaRepository,
  ) {}

  public async createGroup(instance: InstanceDto, create: CreateGroupDto) {
    return await this.waMonitor.waInstances[instance.instanceName].createGroup(create);
  }

  public async updateGroupPicture(instance: InstanceDto, update: GroupPictureDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupPicture(update);
  }

  public async updateGroupSubject(instance: InstanceDto, update: GroupSubjectDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupSubject(update);
  }

  public async updateGroupDescription(instance: InstanceDto, update: GroupDescriptionDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGroupDescription(update);
  }

  public async findGroupInfo(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].findGroup(groupJid);
  }

  public async fetchAllGroups(instance: InstanceDto, getPaticipants: GetParticipant) {
    return await this.waMonitor.waInstances[instance.instanceName].fetchAllGroups(getPaticipants);
  }

  public async inviteCode(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].inviteCode(groupJid);
  }

  public async inviteInfo(instance: InstanceDto, inviteCode: GroupInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].inviteInfo(inviteCode);
  }

  public async sendInvite(instance: InstanceDto, data: GroupSendInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].sendInvite(data);
  }

  public async acceptInviteCode(instance: InstanceDto, inviteCode: AcceptGroupInvite) {
    return await this.waMonitor.waInstances[instance.instanceName].acceptInviteCode(inviteCode);
  }

  public async revokeInviteCode(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].revokeInviteCode(groupJid);
  }

  public async findParticipants(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].findParticipants(groupJid);
  }

  public async updateGParticipate(instance: InstanceDto, update: GroupUpdateParticipantDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGParticipant(update);
  }

  public async updateGSetting(instance: InstanceDto, update: GroupUpdateSettingDto) {
    return await this.waMonitor.waInstances[instance.instanceName].updateGSetting(update);
  }

  public async toggleEphemeral(instance: InstanceDto, update: GroupToggleEphemeralDto) {
    return await this.waMonitor.waInstances[instance.instanceName].toggleEphemeral(update);
  }

  public async leaveGroup(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].leaveGroup(groupJid);
  }

  // ─── [GDW-004] Join-request actions ─────────────────────────────────────
  // Thin pass-through wrappers — the service methods handle errors + cache
  // invalidation. Mirrors the GDW-007 community controller style.

  public async acceptInviteV4(instance: InstanceDto, data: GroupAcceptInviteV4Dto) {
    return await this.waMonitor.waInstances[instance.instanceName].groupAcceptInviteV4(data);
  }

  public async revokeInviteV4(instance: InstanceDto, data: GroupRevokeInviteV4Dto) {
    return await this.waMonitor.waInstances[instance.instanceName].groupRevokeInviteV4(data);
  }

  public async updateMemberAddMode(instance: InstanceDto, data: GroupMemberAddModeDto) {
    return await this.waMonitor.waInstances[instance.instanceName].groupMemberAddMode(data);
  }

  public async updateJoinApprovalMode(instance: InstanceDto, data: GroupJoinApprovalModeDto) {
    return await this.waMonitor.waInstances[instance.instanceName].groupJoinApprovalMode(data);
  }

  public async pendingJoinRequests(instance: InstanceDto, groupJid: GroupJid) {
    return await this.waMonitor.waInstances[instance.instanceName].groupRequestParticipantsList(groupJid);
  }

  public async updatePendingJoinRequests(instance: InstanceDto, data: GroupUpdatePendingRequestsDto) {
    return await this.waMonitor.waInstances[instance.instanceName].groupRequestParticipantsUpdate(data);
  }

  // ─── [GDW-008] Group event audit trail query ───────────────────────────
  // Always available — even when GDW_PERSIST_GROUP_EVENTS=false the
  // endpoint is registered and returns []. See PATCHES.md GDW-008.
  public async findGroupEvents(instance: InstanceDto, query: GroupEventsQueryDto) {
    if (!this.prismaRepository) return [];
    const wa = this.waMonitor.waInstances[instance.instanceName];
    if (!wa?.instanceId) return [];

    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const where: any = {
      instanceId: wa.instanceId,
      groupJid: query.groupJid,
    };
    if (query.type) {
      where.eventType = query.type;
    }
    if (query.since) {
      const since = new Date(query.since);
      if (!isNaN(since.getTime())) {
        where.createdAt = { gte: since };
      }
    }

    return await this.prismaRepository.groupEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
