import { Global, Module } from "@nestjs/common";
import { readRuntimeConfig } from "./runtime-config.js";

export const RUNTIME_CONFIG = Symbol("RUNTIME_CONFIG");

@Global()
@Module({
  providers: [{ provide: RUNTIME_CONFIG, useFactory: readRuntimeConfig }],
  exports: [RUNTIME_CONFIG],
})
export class ConfigModule {}
