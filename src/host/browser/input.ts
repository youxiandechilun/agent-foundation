import { z } from "zod";

/** Input fields shared by the local browser and the paired user-browser bridge actions. */
export const browserInputFields = {
  selector: z.string().max(2000).optional(),
  text: z.string().max(100000).optional(),
  key: z.string().max(100).optional(),
  url: z.string().max(16384).optional(),
  x: z.number().finite().min(-100000).max(100000).optional(),
  y: z.number().finite().min(-100000).max(100000).optional(),
};
