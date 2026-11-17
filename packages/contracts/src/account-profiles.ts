import { z } from "zod";

/** Device-local account profile metadata. Credentials never belong in this contract. */
export const AccountProfileSchema = z.strictObject({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(80),
  serverUrl: z.string().url(),
});

export type AccountProfile = z.infer<typeof AccountProfileSchema>;

/** Sanitized profile list shared with native surfaces; active selection is stored separately. */
export const AccountProfilesSchema = z.array(AccountProfileSchema);

export const PushProfileBindingSchema = z.object({
  clientProfileId: z.string().uuid(),
  serverOrigin: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && url.origin === value;
    }),
});
export type PushProfileBinding = z.infer<typeof PushProfileBindingSchema>;
