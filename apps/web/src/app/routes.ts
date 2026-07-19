import type { Routes } from "@angular/router";
import { ConversationComponent } from "./conversation.component";
import { DiagnosticsComponent } from "./diagnostics.component";
import { SettingsComponent } from "./settings.component";
import { SetupComponent } from "./setup.component";
import { TimersComponent } from "./timers.component";
import { FilesComponent } from "./files.component";
import { TerminalPageComponent } from "./terminal-page.component";

export const routes: Routes = [
  { path: "setup", component: SetupComponent },
  { path: "timers", component: TimersComponent },
  { path: "files", component: FilesComponent },
  { path: "terminal", component: TerminalPageComponent },
  {
    path: "desk",
    loadComponent: () =>
      import("./desk.component").then((module) => module.DeskComponent),
  },
  { path: "settings", component: SettingsComponent },
  { path: "diagnostics", component: DiagnosticsComponent },
  { path: "chat", component: ConversationComponent },
  { path: "chat/:turnId", redirectTo: "chat" },
  { path: "", pathMatch: "full", redirectTo: "chat" },
  { path: "**", redirectTo: "chat" },
];
