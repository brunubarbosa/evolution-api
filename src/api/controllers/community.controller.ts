// [GDW-007] Community controller — thin pass-through to the channel service.
// Style mirrors `src/api/controllers/group.controller.ts`.

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
import { InstanceDto } from '@api/dto/instance.dto';
import { WAMonitoringService } from '@api/services/monitor.service';

export class CommunityController {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  public async communityMetadata(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityMetadata(data);
  }

  public async communityCreate(instance: InstanceDto, data: CommunityCreateDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityCreate(data);
  }

  public async communityCreateGroup(instance: InstanceDto, data: CommunityCreateGroupDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityCreateGroup(data);
  }

  public async communityLeave(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityLeave(data);
  }

  public async communityUpdateSubject(instance: InstanceDto, data: CommunitySubjectDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityUpdateSubject(data);
  }

  public async communityUpdateDescription(instance: InstanceDto, data: CommunityDescriptionDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityUpdateDescription(data);
  }

  public async communityLinkGroup(instance: InstanceDto, data: CommunityLinkGroupDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityLinkGroup(data);
  }

  public async communityUnlinkGroup(instance: InstanceDto, data: CommunityLinkGroupDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityUnlinkGroup(data);
  }

  public async communityFetchLinkedGroups(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityFetchLinkedGroups(data);
  }

  public async communityInviteCode(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityInviteCode(data);
  }

  public async communityRevokeInvite(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityRevokeInvite(data);
  }

  public async communityAcceptInvite(instance: InstanceDto, data: CommunityInviteCode) {
    return await this.waMonitor.waInstances[instance.instanceName].communityAcceptInvite(data);
  }

  public async communityAcceptInviteV4(instance: InstanceDto, data: CommunityAcceptInviteV4Dto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityAcceptInviteV4(data);
  }

  public async communityRevokeInviteV4(instance: InstanceDto, data: CommunityRevokeInviteV4Dto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityRevokeInviteV4(data);
  }

  public async communityRequestParticipantsList(instance: InstanceDto, data: CommunityJid) {
    return await this.waMonitor.waInstances[instance.instanceName].communityRequestParticipantsList(data);
  }

  public async communityRequestParticipantsUpdate(instance: InstanceDto, data: CommunityUpdatePendingRequestsDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityRequestParticipantsUpdate(data);
  }

  public async communityParticipantsUpdate(instance: InstanceDto, data: CommunityUpdateParticipantsDto) {
    return await this.waMonitor.waInstances[instance.instanceName].communityParticipantsUpdate(data);
  }
}
