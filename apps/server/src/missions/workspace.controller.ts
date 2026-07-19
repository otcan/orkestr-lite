import {
  Controller,
  Get,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import {
  MAX_BOX_UPLOAD_BYTES,
  MAX_BOX_UPLOAD_FILES,
  type BoxUpload,
  WorkspaceService,
} from "./workspace.service.js";

@Controller("api/workspace")
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get(["files", "tree"])
  async files() {
    return { data: await this.workspace.tree() };
  }

  @Get("file")
  file(@Query("path") path: string) {
    return this.workspace.preview(path);
  }

  @Get("download")
  async download(
    @Query("path") path: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.workspace.download(path);
    response.download(file.absolute, file.name);
  }

  @Get("box/files")
  boxFiles(@Query("path") path?: string) {
    return this.workspace.boxDirectory(path || "/");
  }

  @Get("box/file")
  boxFile(@Query("path") path: string) {
    return this.workspace.boxPreview(path);
  }

  @Get("box/download")
  async boxDownload(
    @Query("path") path: string,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.workspace.boxDownload(path);
    response.download(file.absolute, file.name);
  }

  @Post("box/upload")
  @UseInterceptors(
    FilesInterceptor("files", MAX_BOX_UPLOAD_FILES, {
      limits: {
        files: MAX_BOX_UPLOAD_FILES,
        fileSize: MAX_BOX_UPLOAD_BYTES,
      },
    }),
  )
  async boxUpload(
    @Query("path") path: string,
    @UploadedFiles() files: BoxUpload[],
  ) {
    return { data: await this.workspace.boxUpload(path, files || []) };
  }

  @Get(["changes", "status", "diff"])
  changes() {
    return this.workspace.changes();
  }
}
