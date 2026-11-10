import { compactId, middleCompact } from "../format";
import type { ResourceIdentityData, ResourceNameKind } from "../types";
import { ProductIcon } from "./ui";

export interface ResourceIdentityValue extends ResourceIdentityData {
  parentIdentity?: ResourceIdentityData | null;
}

export function ResourceIdentity({ identity, showIcon = true, collision = false, className = "" }: {
  identity: ResourceIdentityValue;
  showIcon?: boolean;
  collision?: boolean;
  className?: string;
}) {
  const named = identity.nameKind !== "id_only" && Boolean(identity.cloudflareName);
  const primary = named
    ? middleCompact(identity.cloudflareName!)
    : `${resourceTypeLabel(identity.resourceType, identity.productFamily)} ${collision ? identity.cloudflareId : compactId(identity.cloudflareId)}`;
  const secondary = identity.parentIdentity
    ? identityLabel(identity.parentIdentity, collision)
    : named
      ? `${resourceTypeLabel(identity.resourceType, identity.productFamily)} · ${collision ? identity.cloudflareId : compactId(identity.cloudflareId)}`
      : identity.nameKind === "brolly"
        ? "Brolly aggregate"
        : productLabel(identity.productFamily);

  return (
    <span className={`flex min-w-0 items-center gap-2.5 ${className}`} data-identity-kind={identity.nameKind}>
      {showIcon && identity.productFamily && <ProductIcon family={identity.productFamily} />}
      <span className="flex min-w-0 flex-col gap-[3px]">
        <strong className={`${collision ? "max-w-[72ch] break-all" : "max-w-[52ch] overflow-hidden text-ellipsis whitespace-nowrap"} ${named ? "" : "font-[680]"}`} title={named ? identity.cloudflareName! : identity.cloudflareId}>
          {named ? primary : <>{resourceTypeLabel(identity.resourceType, identity.productFamily)} <code className="font-mono font-[620]">{collision ? identity.cloudflareId : compactId(identity.cloudflareId)}</code></>}
        </strong>
        <small className="max-w-[64ch] overflow-hidden text-ellipsis whitespace-nowrap text-[12px] text-faint" title={secondary}>
          {secondary}
        </small>
      </span>
    </span>
  );
}

export function identityLabel(identity: Pick<ResourceIdentityValue, "cloudflareId" | "cloudflareName" | "nameKind" | "resourceType"> & { productFamily?: string }, collision = false): string {
  if (identity.nameKind !== "id_only" && identity.cloudflareName) return middleCompact(identity.cloudflareName);
  return `${resourceTypeLabel(identity.resourceType, identity.productFamily)} ${collision ? identity.cloudflareId : compactId(identity.cloudflareId)}`;
}

export function resourceTypeLabel(resourceType: string, productFamily?: string): string {
  if (resourceType === "account") return "Account";
  if (resourceType === "product") return "Product";
  const scope = resourceType.split(":").at(-1) ?? resourceType;
  if (productFamily === "durable_objects" && scope === "namespace") return "Durable Object namespace";
  if (productFamily === "durable_objects" && scope === "object") return "Durable Object";
  if (productFamily === "workers" && scope === "resource") return "Worker";
  if (productFamily === "r2" && scope === "resource") return "R2 bucket";
  if (productFamily === "d1" && scope === "resource") return "D1 database";
  if (productFamily === "queues" && scope === "resource") return "Queue";
  if (productFamily === "pages" && scope === "resource") return "Pages project";
  if (productFamily === "vectorize" && scope === "resource") return "Vectorize index";
  if (scope === "namespace") return "Namespace";
  if (scope === "object") return "Object";
  if (scope === "zone") return "Zone";
  if (scope === "resource") return "Resource";
  return title(scope);
}

export function identityCollisions(identities: Array<Pick<ResourceIdentityValue, "cloudflareId">>): Set<string> {
  const compact = new Map<string, string>();
  const collisions = new Set<string>();
  for (const identity of identities) {
    const rendered = compactId(identity.cloudflareId);
    const previous = compact.get(rendered);
    if (previous && previous !== identity.cloudflareId) {
      collisions.add(previous);
      collisions.add(identity.cloudflareId);
    } else {
      compact.set(rendered, identity.cloudflareId);
    }
  }
  return collisions;
}

function productLabel(value?: string): string {
  return value ? title(value) : "Cloudflare resource";
}

function title(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export function identityValue(value: {
  cloudflareId: string;
  cloudflareName: string | null;
  nameKind: ResourceNameKind;
  resourceType: string;
  productFamily?: string;
  parentIdentity?: ResourceIdentityData | null;
}): ResourceIdentityValue {
  return value;
}
