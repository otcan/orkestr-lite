import { Module } from "@nestjs/common";
import { MissionEventBus } from "./mission-event.bus.js";
import { MissionRepository } from "./mission.repository.js";
import { MissionsController } from "./missions.controller.js";
import { MissionsService } from "./missions.service.js";

@Module({
  controllers: [MissionsController],
  providers: [MissionEventBus, MissionRepository, MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
