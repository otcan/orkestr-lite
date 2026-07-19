import { Module } from "@nestjs/common";
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";
import { MissionsController } from "./missions.controller.js";
import { MissionsService } from "./missions.service.js";
import { ConversationController } from "./conversation.controller.js";
import { WorkspaceController } from "./workspace.controller.js";
import { WorkspaceService } from "./workspace.service.js";
import { TimersController } from "./timers.controller.js";
import { TimersService } from "./timers.service.js";
import { createWhatsAppClient } from "../whatsapp/whatsapp-client.factory.js";
import { WhatsAppController } from "../whatsapp/whatsapp.controller.js";
import { WhatsAppService } from "../whatsapp/whatsapp.service.js";
import { WHATSAPP_CLIENT_FACTORY } from "../whatsapp/whatsapp.types.js";
import { ConversationTelemetryService } from "./conversation-telemetry.service.js";
import { AttachmentsService } from "./attachments.service.js";

@Module({
  controllers: [
    MissionsController,
    ConversationController,
    WorkspaceController,
    WhatsAppController,
    TimersController,
  ],
  providers: [
    MissionEventBus,
    MissionRepository,
    MissionsService,
    ConversationTelemetryService,
    AttachmentsService,
    WorkspaceService,
    WhatsAppService,
    TimersService,
    { provide: WHATSAPP_CLIENT_FACTORY, useValue: createWhatsAppClient },
  ],
  exports: [MissionsService, WhatsAppService],
})
export class MissionsModule {}
