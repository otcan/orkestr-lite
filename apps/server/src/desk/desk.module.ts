import { Module } from "@nestjs/common";
import { MissionsModule } from "../missions/missions.module.js";
import { DeskController } from "./desk.controller.js";
import { DeskService } from "./desk.service.js";

@Module({
  imports: [MissionsModule],
  controllers: [DeskController],
  providers: [DeskService],
  exports: [DeskService],
})
export class DeskModule {}
