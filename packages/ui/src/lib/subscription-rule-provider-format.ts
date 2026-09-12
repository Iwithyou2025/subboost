export type SubscriptionRuleProviderFormat = "mrs" | "yaml";

const STORAGE_PREFIX = "subboost:subscription-rule-provider-format:v1:";

function normalizeSubscriptionUrl(subscriptionUrl: string): string {
    return subscriptionUrl.replace(
        /\/config-yaml\.yaml(?=([?#]|$))/,
        "/config.yaml"
    );
}

function resolveSubscriptionIdentity(subscriptionUrl: string): string {
    const normalized = normalizeSubscriptionUrl(subscriptionUrl);

    try {
        const parsed = new URL(normalized, "http://subboost.local");
        const match = parsed.pathname.match(
            /\/api\/subscriptions\/([^/]+)\/config\.yaml$/
        );

        if (match?.[1]) {
            return match[1];
        }
    } catch {
        // URL 无法解析时使用原字符串
    }

    return normalized;
}

function hashText(value: string): string {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return (hash >>> 0).toString(36);
}

function buildStorageKey(subscriptionUrl: string): string {
    return `${STORAGE_PREFIX}${hashText(
        resolveSubscriptionIdentity(subscriptionUrl)
    )}`;
}

export function buildYamlRuleSubscriptionUrl(
    subscriptionUrl: string
): string {
    if (!subscriptionUrl) {
        return "";
    }

    if (/\/config-yaml\.yaml(?=([?#]|$))/.test(subscriptionUrl)) {
        return subscriptionUrl;
    }

    return subscriptionUrl.replace(
        /\/config\.yaml(?=([?#]|$))/,
        "/config-yaml.yaml"
    );
}

export function getSubscriptionRuleProviderFormat(
    subscriptionUrl: string
): SubscriptionRuleProviderFormat {
    if (!subscriptionUrl) {
        return "mrs";
    }

    try {
        return globalThis.localStorage?.getItem(
            buildStorageKey(subscriptionUrl)
        ) === "yaml"
            ? "yaml"
            : "mrs";
    } catch {
        return "mrs";
    }
}

export function setSubscriptionRuleProviderFormat(
    subscriptionUrl: string,
    format: SubscriptionRuleProviderFormat
): void {
    if (!subscriptionUrl) {
        return;
    }

    try {
        const storage = globalThis.localStorage;

        if (!storage) {
            return;
        }

        const key = buildStorageKey(subscriptionUrl);

        if (format === "yaml") {
            storage.setItem(key, "yaml");
        } else {
            storage.removeItem(key);
        }
    } catch {
        // localStorage 不可用时继续使用默认 MRS
    }
}

export function resolvePreferredSubscriptionUrl(
    subscriptionUrl: string
): string {
    return getSubscriptionRuleProviderFormat(subscriptionUrl) === "yaml"
        ? buildYamlRuleSubscriptionUrl(subscriptionUrl)
        : normalizeSubscriptionUrl(subscriptionUrl);
}