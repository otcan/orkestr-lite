import type { Routes } from "@angular/router";
import { MissionDetailComponent } from "./mission-detail.component";
import { MissionsComponent } from "./missions.component";
import { SetupComponent } from "./setup.component";

export const routes: Routes = [
  { path: "missions", component: MissionsComponent },
  { path: "missions/:id", component: MissionDetailComponent },
  { path: "setup", component: SetupComponent },
  { path: "", pathMatch: "full", redirectTo: "missions" },
  { path: "**", redirectTo: "missions" },
];
