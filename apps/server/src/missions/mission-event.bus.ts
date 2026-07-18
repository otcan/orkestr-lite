import { Injectable } from "@nestjs/common";
import type { MissionEventRecord } from "@orkestr/shared";
import { EventEmitter } from "node:events";

interface MissionEventBusEvents {
  event: [event: MissionEventRecord];
}

@Injectable()
export class MissionEventBus {
  private readonly emitter = new EventEmitter<MissionEventBusEvents>();

  publish(event: MissionEventRecord): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: MissionEventRecord) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
