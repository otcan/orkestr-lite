import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "orkestr:isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);
