import type {
  MediaAdapter,
  MediaAdapterContext,
  AdapterResult,
  MediaRequest,
} from "../src/index.js";

/** Example vendor protocol adapter. It makes actual HTTP requests; endpoint paths must match your vendor. */
export class VendorVideoAdapter implements MediaAdapter {
  id = "my-vendor-video";
  capabilities = {
    kinds: ["video"] as "video"[],
    operations: ["generate", "edit"] as MediaRequest["operation"][],
    cancellation: true,
    recovery: true,
  };
  async submit(
    input: MediaRequest,
    context: MediaAdapterContext,
  ): Promise<AdapterResult> {
    const references = await Promise.all(
      input.inputAssets.map((id) => context.input(id)),
    );
    const response = await context.request("/jobs", {
      engine: context.route.model,
      instruction: input.prompt,
      settings: input.parameters,
      references,
    });
    return this.normalize(response);
  }
  async poll(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ) {
    return this.normalize(
      await context.request(`/jobs/${encodeURIComponent(remoteId)}`),
    );
  }
  async recover(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ) {
    return this.poll(remoteId, state, context);
  }
  async cancel(
    remoteId: string,
    state: Record<string, unknown> | undefined,
    context: MediaAdapterContext,
  ) {
    return this.normalize(
      await context.request(
        `/jobs/${encodeURIComponent(remoteId)}/cancel`,
        {},
        "POST",
      ),
    );
  }
  private normalize(value: any): AdapterResult {
    const states: Record<string, AdapterResult["status"]> = {
      PENDING: "queued",
      PROCESSING: "running",
      SUCCEEDED: "completed",
      FAILED: "failed",
      CANCELLED: "cancelled",
    };
    const status = states[value.state];
    if (!status) throw Error(`Unsupported vendor state: ${value.state}`);
    return {
      remoteId: value.handle,
      status,
      progress:
        typeof value.percent === "number" ? value.percent / 100 : undefined,
      outputs: value.files?.map((file: any) => ({
        type: "video",
        url: file.download_url,
        mime: file.mime_type,
      })),
      error: value.error?.description,
    };
  }
}
// In your host entry: kernel.media.adapters.register(new VendorVideoAdapter());
// Route: kind='video', adapter='media-http', mediaAdapterId='my-vendor-video'.
