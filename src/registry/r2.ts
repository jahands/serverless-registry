import { Env } from "../..";
import jwt from "@tsndr/cloudflare-worker-jwt";
import {
  MINIMUM_CHUNK,
  MAXIMUM_CHUNK_UPLOAD_SIZE,
  MAXIMUM_CHUNK,
  getChunkBlob,
  getHelperR2Path,
  limit,
  split,
} from "../chunk";
import { InternalError, ManifestError, RangeError, ServerError } from "../errors";
import { SHA256_PREFIX_LEN, getSHA256, hexToDigest } from "../user";
import { readableToBlob, readerToBlob, wrap } from "../utils";
import { BlobUnknownError, ManifestUnknownError } from "../v2-errors";
import {
  CheckLayerResponse,
  CheckManifestResponse,
  FinishedUploadObject,
  GetLayerResponse,
  GetManifestResponse,
  ListRepositoriesResponse,
  PutManifestResponse,
  Registry,
  RegistryError,
  UploadId,
  UploadObject,
  wrapError,
} from "./registry";
import { GarbageCollectionMode, GarbageCollector } from "./garbage-collector";
import { ManifestSchema, manifestSchema } from "../manifest";

export type Chunk =
  | {
      // Chunk that is less than 5GiB and respects the Chunk chain.
      // If you want to append to the chunk list see the following rules:
      // - If same size as last chunk, it's a normal multi-part-chunk.
      // - If not same size as last chunk, it's a multi-part-chunk-no-same-size.
      // - If less than 10MB, it's a small-chunk.
      type: "multi-part-chunk";
      uploadId: string;
      size: number;
    }
  | {
      // Chunk that is less than 5GiB, however it's the last chunk uploaded
      // but it's above 10MB. If you want to append from this, you have to also upload to a different object
      // so you can recover this chunk
      type: "multi-part-chunk-no-same-size";
      uploadId: string;
      r2Path: string;
      size: number;
    }
  | {
      // Small chunk that is less than 10MB
      type: "small-chunk";
      size: number;
      r2Path: string;
      uploadId: string;
    };

export type State = {
  parts: R2UploadedPart[];
  chunks: Chunk[];
  uploadId: string;
  registryUploadId: string;
  byteRange: number;
  name: string;
};

export function getRegistryUploadsPath(state: { registryUploadId: string; name: string }): string {
  return `${state.name}/uploads/${state.registryUploadId}`;
}

export async function getJWT(env: Env, state: { registryUploadId: string; name: string }): Promise<string | null> {
  const stateObject = await env.REGISTRY.get(getRegistryUploadsPath(state));
  if (stateObject === null) return null;
  try {
    const metadata = await stateObject.json<{ jwt?: string }>();
    if (!metadata) return null;
    if (!metadata.jwt || typeof metadata.jwt !== "string") {
      return null;
    }
    return metadata.jwt;
  } catch (e) {
    console.error("Error parsing metadata", e);
    return null;
  }
}

export async function encodeState(state: State, env: Env): Promise<{ jwt: string; hash: string }> {
  const jwtSignature = await jwt.sign(
    { ...state, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 2 },
    // TODO: Remove JWT encoding and use something faster like just plain bas64
    "secret-doesnt-matter-anymore-we-are-using-jwt-for-encoding-state",
    {
      algorithm: "HS256",
    },
  );

  await env.REGISTRY.put(getRegistryUploadsPath(state), JSON.stringify({ jwt: jwtSignature }));
  return { jwt: jwtSignature, hash: await getSHA256(jwtSignature, "") };
}

export const symlinkHeader = "X-Serverless-Registry-Symlink";

export async function getUploadState(
  name: string,
  uploadId: string,
  env: Env,
  verifyHash: string | undefined,
): Promise<{ state: State; stateStr: string; hash: string } | RangeError | null> {
  const stateStr = await getJWT(env, { registryUploadId: uploadId, name: name });
  if (stateStr === null) {
    return null;
  }

  const stateStrHash = await getSHA256(stateStr, "");
  // We are skipping state jwt verifying as it doesn't make sense anymore, we are already verifying it's the latest by looking into R2 and comparing the hash.
  const stateObject = jwt.decode<State>(stateStr).payload;
  if (!stateObject) {
    console.error("Payload property is not in the JWT");
    throw new InternalError();
  }

  if (verifyHash !== undefined && stateStrHash !== verifyHash) {
    return new RangeError(stateStrHash, stateObject);
  }

  return { state: stateObject, stateStr: stateStr, hash: stateStrHash };
}

export class R2Registry implements Registry {
  private gc: GarbageCollector;

  constructor(private env: Env) {
    this.gc = new GarbageCollector(this.env.REGISTRY);
  }

  async manifestExists(name: string, reference: string): Promise<RegistryError | CheckManifestResponse> {
    const [res, err] = await wrap(this.env.REGISTRY.head(`${name}/manifests/${reference}`));
    if (err) {
      return wrapError("manifestExists", err);
    }

    if (!res) {
      return {
        exists: false,
      };
    }

    if (res.checksums.sha256 === null) {
      return { response: new ServerError("invalid checksum from R2 backend") };
    }

    return {
      exists: true,
      digest: hexToDigest(res.checksums.sha256!),
      contentType: res.httpMetadata!.contentType!,
      size: res.size,
    };
  }

  async listRepositories(limit?: number, last?: string): Promise<RegistryError | ListRepositoriesResponse> {
    // The idea in listRepositories is list all entries in the R2 bucket and map them to repositories.
    // We do this by taking advantage of the name format in the R2 bucket:
    // name format is:
    //   <path>/<'blobs' | 'manifests'>/<name>
    // This means we slice the last two items in the key and add them to our hash map.
    // At the end, we start skipping entries until we find another unique key, then we return that entry as startAfter.

    const options = {
      limit: limit ?? 1000,
      startAfter: last ?? undefined,
    };
    const repositories: Record<string, {}> = {};
    let totalRecords = 0;
    let lastSeen: string | undefined;
    const objectExistsInPath = (entry?: string) => {
      if (entry === undefined) return false;
      const parts = entry.split("/");
      const repository = parts.slice(0, parts.length - 2).join("/");
      return repository in repositories;
    };

    const repositoriesOrder: string[] = [];
    const addObjectPath = (object: R2Object) => {
      if (totalRecords >= options.limit && !objectExistsInPath(object.key)) {
        return;
      }

      // update lastSeen for cursoring purposes
      lastSeen = object.key;
      // don't add if seen before
      if (totalRecords >= options.limit) return;
      // skip either 'manifests' or 'blobs'
      // name format is:
      // <path>/<'blobs' | 'manifests'>/<name>
      const parts = object.key.split("/");
      const repository = parts.slice(0, parts.length - 2).join("/");
      if (parts[parts.length - 2] === "blobs") return;

      if (repository in repositories) return;
      totalRecords++;
      repositories[repository] = {};
      repositoriesOrder.push(repository);
    };

    const r2Objects = await this.env.REGISTRY.list({
      limit: 50,
      startAfter: options.startAfter,
    });
    r2Objects.objects.forEach((path) => addObjectPath(path));
    let cursor = r2Objects.truncated ? r2Objects.cursor : undefined;
    while (cursor !== undefined && totalRecords < options.limit) {
      const next = await this.env.REGISTRY.list({
        limit: 50,
        cursor,
      });
      next.objects.forEach((path) => addObjectPath(path));
      if (next.truncated) {
        cursor = next.cursor;
      } else {
        cursor = undefined;
      }
    }

    while (cursor !== undefined && typeof lastSeen === "string" && objectExistsInPath(lastSeen)) {
      const nextList: R2Objects = await this.env.REGISTRY.list({
        limit: 50,
        cursor,
      });

      let found = false;
      // Search for the next object in the list
      for (const object of nextList.objects) {
        if (!objectExistsInPath(lastSeen)) {
          found = true;
          break;
        }

        lastSeen = object.key;
      }

      if (found) break;

      if (nextList.truncated) {
        // jump to the next list and try to find a
        // repository that hasn't been returned in this response
        cursor = nextList.cursor;
      } else {
        // we arrived to the end of the list, no more cursor
        cursor = undefined;
      }
    }

    return {
      repositories: repositoriesOrder,
      cursor: lastSeen,
    };
  }

  async verifyManifest(name: string, manifest: ManifestSchema) {
    if (manifest.schemaVersion === 2 && "manifests" in manifest) {
      for (const manifestElement of manifest.manifests) {
        const key = manifestElement.digest;
        const res = await this.env.REGISTRY.head(`${name}/manifests/${key}`);
        if (res === null) {
          console.error(`Manifest with digest ${key} doesn't exist`);
          return new ManifestError("BLOB_UNKNOWN", `unknown manifest ${key}`);
        }
      }

      return null;
    }

    const layers: string[] =
      manifest.schemaVersion === 1
        ? manifest.fsLayers.map((layer) => layer.blobSum)
        : [...manifest.layers.map((layer) => layer.digest), manifest.config.digest];
    for (const key of layers) {
      const res = await this.env.REGISTRY.head(`${name}/blobs/${key}`);
      if (res === null) {
        console.error(`Digest ${key} doesn't exist`);
        return new ManifestError("BLOB_UNKNOWN", `unknown blob ${key}`);
      }
    }

    return null;
  }

  async putManifest(
    namespace: string,
    reference: string,
    readableStream: ReadableStream<any>,
    {
      contentType,
      checkLayers,
    }: {
      contentType: string;
      checkLayers?: boolean;
    },
  ): Promise<PutManifestResponse | RegistryError> {
    const key = await this.gc.markForInsertion(namespace);
    try {
      return this.putManifestInner(
        namespace,
        reference,
        readableStream,
        contentType,
        checkLayers !== undefined ? checkLayers === true : true,
      );
    } finally {
      // if this fails, at some point it will be expired
      await this.gc.cleanInsertion(namespace, key);
    }
  }

  async putManifestInner(
    name: string,
    reference: string,
    readableStream: ReadableStream<any>,
    contentType: string,
    checkLayers: boolean,
  ): Promise<PutManifestResponse | RegistryError> {
    const gcMarker = await this.gc.getGCMarker(name);
    const env = this.env;
    const sha256 = new crypto.DigestStream("SHA-256");
    const reader = readableStream.getReader();
    const shaWriter = sha256.getWriter();
    const blob = await readableToBlob(reader, shaWriter);
    reader.releaseLock();
    shaWriter.close();
    const digest = await sha256.digest;
    const digestStr = hexToDigest(digest);
    const text = await blob.text();
    const manifestJSON = JSON.parse(text);
    const manifest = manifestSchema.parse(manifestJSON);
    if (checkLayers) {
      const verifyManifestErr = await this.verifyManifest(name, manifest);
      if (verifyManifestErr !== null) return { response: verifyManifestErr };
    }

    if (!(await this.gc.checkCanInsertData(name, gcMarker))) {
      console.error("Manifest can't be uploaded as there is/was a garbage collection going");
      return { response: new ServerError("garbage collection is on-going... check with registry administrator", 500) };
    }

    const putReference = async () => {
      // if the reference is the same as a digest, it's not necessary to insert
      if (reference === digestStr) return;
      return await env.REGISTRY.put(`${name}/manifests/${reference}`, text, {
        sha256: digest,
        httpMetadata: {
          contentType,
        },
      });
    };

    await Promise.all([
      putReference(),
      // this is the "main" manifest
      env.REGISTRY.put(`${name}/manifests/${digestStr}`, text, {
        sha256: digest,
        httpMetadata: {
          contentType,
        },
      }),
    ]);
    return {
      digest: hexToDigest(digest),
      location: `/v2/${name}/manifests/${reference}`,
    };
  }

  async getManifest(name: string, reference: string): Promise<RegistryError | GetManifestResponse> {
    const [res, err] = await wrap(this.env.REGISTRY.get(`${name}/manifests/${reference}`));
    if (err) {
      return wrapError("getManifest", err);
    }

    if (!res) {
      return {
        response: new Response(JSON.stringify(ManifestUnknownError), { status: 404 }),
      };
    }

    return {
      stream: res.body!,
      digest: hexToDigest(res.checksums.sha256!),
      size: res.size,
      contentType: res.httpMetadata!.contentType!,
    };
  }

  async mountExistingLayer(
    sourceName: string,
    digest: string,
    destinationName: string,
  ): Promise<RegistryError | FinishedUploadObject> {
    const sourceLayerPath = `${sourceName}/blobs/${digest}`;
    const [res, err] = await wrap(this.env.REGISTRY.head(sourceLayerPath));
    if (err) {
      return wrapError("mountExistingLayer", err);
    }
    if (!res) {
      return wrapError("mountExistingLayer", "Layer not found");
    } else {
      const destinationLayerPath = `${destinationName}/blobs/${digest}`;
      if (sourceLayerPath === destinationLayerPath) {
        // Bad request
        throw new InternalError();
      }
      // Prevent recursive symlink
      if (res.customMetadata && symlinkHeader in res.customMetadata) {
        return await this.mountExistingLayer(res.customMetadata[symlinkHeader], digest, destinationName);
      }
      // Trying to mount a layer from sourceLayerPath to destinationLayerPath

      // Create linked file with custom metadata
      const [newFile, error] = await wrap(
        this.env.REGISTRY.put(destinationLayerPath, sourceLayerPath, {
          sha256: await getSHA256(sourceLayerPath, ""),
          httpMetadata: res.httpMetadata,
          customMetadata: { [symlinkHeader]: sourceName }, // Storing target repository name in metadata (to easily resolve recursive layer mounting)
        }),
      );
      if (error) {
        return wrapError("mountExistingLayer", error);
      }
      if (newFile && "response" in newFile) {
        return wrapError("mountExistingLayer", newFile.response);
      }

      return {
        digest: hexToDigest(res.checksums.sha256!),
        location: `/v2/${destinationLayerPath}`,
      };
    }
  }

  async layerExists(name: string, tag: string): Promise<RegistryError | CheckLayerResponse> {
    const [res, err] = await wrap(this.env.REGISTRY.head(`${name}/blobs/${tag}`));
    if (err) {
      return wrapError("layerExists", err);
    }

    if (!res) {
      return {
        exists: false,
      };
    }

    return {
      digest: hexToDigest(res.checksums.sha256!),
      size: res.size,
      exists: true,
    };
  }

  async getLayer(name: string, digest: string): Promise<RegistryError | GetLayerResponse> {
    const [res, err] = await wrap(this.env.REGISTRY.get(`${name}/blobs/${digest}`));
    if (err) {
      return wrapError("getLayer", err);
    }

    if (!res) {
      return {
        response: new Response(JSON.stringify(BlobUnknownError), { status: 404 }),
      };
    }

    // Handle R2 symlink
    if (res.customMetadata && symlinkHeader in res.customMetadata) {
      const layerPath = await res.text();
      // Symlink detected! Will download layer from "layerPath"
      const [linkName, linkDigest] = layerPath.split("/blobs/");
      if (linkName == name && linkDigest == digest) {
        return {
          response: new Response(JSON.stringify(BlobUnknownError), { status: 404 }),
        };
      }
      return await this.env.REGISTRY_CLIENT.getLayer(linkName, linkDigest);
    }

    return {
      stream: res.body!,
      digest: hexToDigest(res.checksums.sha256!),
      size: res.size,
    };
  }

  async startUpload(namespace: string): Promise<RegistryError | UploadObject> {
    // Generate a unique ID for this upload
    const uuid = crypto.randomUUID();

    const upload = await this.env.REGISTRY.createMultipartUpload(uuid);
    const state = {
      uploadId: upload.uploadId,
      parts: [],
      registryUploadId: uuid,
      byteRange: 0,
      name: namespace,
      chunks: [],
    };
    const hashedJwtState = await encodeState(state, this.env);
    return {
      maximumBytesPerChunk: MAXIMUM_CHUNK_UPLOAD_SIZE,
      minimumBytesPerChunk: MINIMUM_CHUNK,
      id: uuid,
      location: `/v2/${namespace}/blobs/uploads/${uuid}?_stateHash=${hashedJwtState.hash}`,
      range: [0, 0],
    };
  }

  async getUpload(namespace: string, uploadId: string): Promise<UploadObject | RegistryError> {
    const state = await getUploadState(namespace, uploadId, this.env, undefined);
    if (state === null) {
      return {
        response: new Response(null, { status: 404 }),
      };
    }
    // kind of unreachable, as RangeErrors are only thrown for invalid states
    if (state instanceof RangeError) {
      return { response: new InternalError() };
    }

    return {
      id: uploadId,
      maximumBytesPerChunk: MAXIMUM_CHUNK_UPLOAD_SIZE,
      minimumBytesPerChunk: MINIMUM_CHUNK,
      location: `/v2/${namespace}/blobs/uploads/${uploadId}?_stateHash=${state.hash}`,
      // Note that the HTTP Range header byte ranges are inclusive and that will be honored, even in non-standard use cases.
      range: [0, state.state.byteRange - 1],
    };
  }

  async uploadChunk(
    namespace: string,
    uploadId: string,
    location: string,
    stream: ReadableStream<any>,
    length?: number | undefined,
    range?: [number, number] | undefined,
  ): Promise<RegistryError | UploadObject> {
    const urlObject = new URL("https://r2-registry.com" + location);
    const stateHash = urlObject.searchParams.get("_stateHash");
    if (stateHash === null) {
      console.error("State hash is missing");
      return { response: new InternalError() };
    }

    const hashedState = await getUploadState(namespace, uploadId, this.env, stateHash);
    if (hashedState instanceof RangeError)
      return {
        response: hashedState,
      };

    const state = hashedState?.state;
    if (!state) {
      return { response: new InternalError() };
    }

    const [start, end] = range ?? [undefined, undefined];
    if (
      start !== undefined &&
      end !== undefined &&
      (state.byteRange !== +start || state.byteRange >= +end || +start >= +end)
    ) {
      return { response: new RangeError(stateHash, state) };
    }

    if (state.parts.length >= 10000) {
      console.error("We're trying to upload 1k parts");
      return { response: new InternalError() };
    }

    const upload = this.env.REGISTRY.resumeMultipartUpload(state.registryUploadId, state.uploadId);
    const uuid = state.registryUploadId;
    const env = this.env;

    // This function tries to handle the following cases:
    //  1. Normal case where all chunks are the same and they are all above 5MiB except the last one
    //  2. Case where the chunk is bigger than 5GiB, in that case it will try to split it
    //  3. Case where the chunk is less than the previous one and the previous one was already different
    //
    // The reason we have to do this is that we have to attend the rules of R2:
    // Limitations
    //    Object part sizes must be at least 5MiB but no larger than 5GiB. All parts except the last one must be the same size. The last part has no minimum size, but must be the same or smaller than the other parts.
    //    The maximum number of parts is 10,000.
    //    Most S3 clients conform to these expectations.
    const appendStreamKnownLength = async (stream: ReadableStream, size: number) => {
      // This is the normal code-path, hopefully by hinting with headers on the POST call all clients respect this
      if (
        (state.chunks.length === 0 ||
          (state.chunks[state.chunks.length - 1].size === size &&
            state.chunks[state.chunks.length - 1].type === "multi-part-chunk")) &&
        size <= MAXIMUM_CHUNK &&
        size >= MINIMUM_CHUNK
      ) {
        state.chunks.push({
          type: "multi-part-chunk",
          size,
          uploadId: uuid,
        });
        const part = await upload.uploadPart(state.parts.length + 1, stream);
        state.parts.push(part);
        return;
      }

      // This happens when maximum chunk's is surpassed, so we basically have to split this stream.
      // You can test very easy this branch of code by putting MAXIMUM_CHUNK == MINIMUM_CHUNK and docker pushing against the server.
      if (size > MAXIMUM_CHUNK) {
        for await (const [reader, chunkSize] of split(stream, size, MAXIMUM_CHUNK)) {
          await appendStreamKnownLength(reader, chunkSize);
        }

        return undefined;
      }

      const lastChunk = state.chunks.length ? state.chunks[state.chunks.length - 1] : undefined;
      // This is a bad scenario, we uploaded a chunk and we have to copy.
      if (
        env.PUSH_COMPATIBILITY_MODE === "full" &&
        lastChunk &&
        (lastChunk.type === "small-chunk" || lastChunk.type === "multi-part-chunk-no-same-size")
      ) {
        // nullability: getChunkStream for small-chunk always returns stream
        const chunkStream = (await getChunkBlob(env, lastChunk))!;
        // pop as we're going to override last part
        state.chunks.pop();
        state.parts.pop();
        const blob = await readerToBlob(stream);
        const streamCombined = new Blob([chunkStream, blob]);
        await appendStreamKnownLength(limit(streamCombined.stream(), size + lastChunk.size), size + lastChunk.size);
        return;
      }

      // Only allow this branch when the last pushed chunk is multi-part-chunk
      // as we will upload the part directly. This is a normal workflow if the client is a good citizen
      if (
        (lastChunk && lastChunk.size > size) ||
        (size < MINIMUM_CHUNK && (!lastChunk || lastChunk.type === "multi-part-chunk"))
      ) {
        const path = getHelperR2Path(uuid);
        state.chunks.push({
          type: size < MINIMUM_CHUNK ? "small-chunk" : "multi-part-chunk-no-same-size",
          size,
          uploadId: uuid,
          r2Path: path,
        });

        if (env.PUSH_COMPATIBILITY_MODE === "full") {
          const [stream1, stream2] = limit(stream, size).tee();
          const partTask = upload.uploadPart(state.parts.length + 1, stream1);
          // We can totally disable this, however we are risking that the client sends another small chunk.
          // Maybe instead we can throw range error
          const dateInOneHour = new Date();
          dateInOneHour.setTime(dateInOneHour.getTime() + 60 * 60 * 1000);
          const headers = {
            // https://www.rfc-editor.org/rfc/rfc1123 date format
            // Objects will typically be removed from a bucket within 24 hours of the x-amz-expiration value.
            "x-amz-expiration": dateInOneHour.toUTCString(),
          } as const;
          const r2RegistryObjectTask = env.REGISTRY.put(path, stream2, {
            httpMetadata: new Headers(headers),
            customMetadata: headers,
          });
          state.parts.push(await partTask);
          await r2RegistryObjectTask;
          return;
        }

        state.parts.push(await upload.uploadPart(state.parts.length + 1, stream));
        return;
      }

      // we know here that size >= MINIMUM_CHUNK and size >= lastChunk.size, this is just super inefficient, maybe in the future just throw RangeError here...
      if (env.PUSH_COMPATIBILITY_MODE === "full" && lastChunk && size >= lastChunk.size) {
        console.warn(
          "The client is being a bad citizen by trying to send a new chunk bigger than the chunk it sent. If this is giving problems disable this codepath altogether",
        );
        for await (const [chunk, chunkSize] of split(stream, size, lastChunk.size)) {
          await appendStreamKnownLength(chunk, chunkSize);
        }

        return undefined;
      }

      if (env.PUSH_COMPATIBILITY_MODE === "full") {
        throw new ServerError("unreachable", 500);
      }

      return new RangeError(stateHash, state);
    };

    if (length === undefined) {
      console.error("Length needs to be defined");
      return {
        response: new InternalError(),
      };
    }

    const res = await appendStreamKnownLength(stream, length);
    state.byteRange += length;
    if (res instanceof RangeError)
      return {
        response: res,
      };

    const hashedJwtState = await encodeState(state, env);
    return {
      id: uuid,
      range: [0, state.byteRange - 1],
      location: `/v2/${namespace}/blobs/uploads/${uuid}?_stateHash=${hashedJwtState.hash}`,
    };
  }

  async finishUpload(
    namespace: string,
    uploadId: string,
    location: string,
    expectedSha: string,
    stream?: ReadableStream<any> | undefined,
    length?: number | undefined,
  ): Promise<RegistryError | FinishedUploadObject> {
    const urlObject = new URL("https://r2-registry.com" + location);
    const stateHash = urlObject.searchParams.get("_stateHash");
    if (stateHash === null) {
      console.error("State hash is missing");
      return { response: new InternalError() };
    }

    const hashedState = await getUploadState(namespace, uploadId, this.env, stateHash);
    if (hashedState instanceof RangeError) {
      return {
        response: hashedState,
      };
    }
    if (hashedState === null || !hashedState.state) {
      return { response: new InternalError() };
    }
    const state = hashedState.state;

    const uuid = state.registryUploadId;
    if (state.parts.length === 0) {
      if (!stream) {
        console.error("There has been an upload with zero parts and the body is null");
        return {
          response: new InternalError(),
        };
      }

      if (length && length > MAXIMUM_CHUNK) {
        console.error("Surpasses MAXIMUM_CHUNK");
        return {
          response: new InternalError(),
        };
      }

      await this.env.REGISTRY.put(`${namespace}/blobs/${expectedSha}`, stream, {
        sha256: (expectedSha as string).slice(SHA256_PREFIX_LEN),
      });
    } else {
      const upload = this.env.REGISTRY.resumeMultipartUpload(uuid, state.uploadId);
      // TODO: Handle one last buffer here
      await upload.complete(state.parts);
      const obj = await this.env.REGISTRY.get(uuid);
      const put = this.env.REGISTRY.put(`${namespace}/blobs/${expectedSha}`, obj!.body, {
        sha256: (expectedSha as string).slice(SHA256_PREFIX_LEN),
      });

      await put;
      await this.env.REGISTRY.delete(uuid);
    }

    await this.env.REGISTRY.delete(getRegistryUploadsPath(state));

    return {
      digest: expectedSha,
      location: `/v2/${namespace}/blobs/${expectedSha}`,
    };
  }

  async cancelUpload(name: string, uploadId: UploadId): Promise<true | RegistryError> {
    const hashedState = await getUploadState(name, uploadId, this.env, undefined);
    if (hashedState instanceof RangeError) {
      return { response: new InternalError() };
    }
    if (hashedState === null || !hashedState.state) {
      return {
        response: new Response(null, { status: 404 }),
      };
    }
    const state = hashedState.state;

    const upload = this.env.REGISTRY.resumeMultipartUpload(state.registryUploadId, state.uploadId);
    await upload.abort();
    await this.env.REGISTRY.delete(getRegistryUploadsPath(state));
    return true;
  }

  async monolithicUpload(
    namespace: string,
    sha256: string,
    stream: ReadableStream,
    size?: number,
  ): Promise<FinishedUploadObject | RegistryError | false> {
    if (!size) {
      const blob = await readableToBlob(stream.getReader());
      stream = blob.stream();
      size = blob.size;
    }

    if (size > MAXIMUM_CHUNK) {
      return false;
    }

    await this.env.REGISTRY.put(`${namespace}/blobs/${sha256}`, stream, {
      sha256: (sha256 as string).slice(SHA256_PREFIX_LEN),
    });
    return {
      digest: sha256,
      location: `/v2/${namespace}/blobs/${sha256}`,
    };
  }

  async garbageCollection(namespace: string, mode: GarbageCollectionMode): Promise<boolean> {
    return await this.gc.collect({ name: namespace, mode: mode });
  }
}
