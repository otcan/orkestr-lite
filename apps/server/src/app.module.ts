import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { AuthModule } from "./auth/auth.module.js";
import { CodexModule } from "./codex/codex.module.js";
import { ConfigModule } from "./config/config.module.js";
import { readRuntimeConfig } from "./config/runtime-config.js";
import { DatabaseModule } from "./database/database.module.js";
import { MissionsModule } from "./missions/missions.module.js";
import { SystemModule } from "./system/system.module.js";

const runtime = readRuntimeConfig();

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    CodexModule,
    MissionsModule,
    SystemModule,
    ServeStaticModule.forRoot({
      rootPath: runtime.publicDir,
      exclude: ["/api/{*splat}"],
    }),
  ],
})
export class AppModule {}
