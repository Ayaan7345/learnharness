/**
 * Settings → Providers → Search shows Firecrawl beside Brave: the URL is
 * visible (it is not a secret) and a save goes through the existing keys API.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { AUTH_KEYS, type AuthKeyStatus } from "../src/core/index.ts";

it("the Search group shows the Firecrawl URL in full and saves it through /api/keys", async () => {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const info = AUTH_KEYS.find((key) => key.id === "FIRECRAWL_API_URL")!;
	const row = (id: string, present = false): AuthKeyStatus => ({
		id,
		info: AUTH_KEYS.find((key) => key.id === id) ?? null,
		present,
		masked: present && id === "FIRECRAWL_API_URL" ? "http://192.168.7.5:3002 (22 chars)" : present ? "…ab12 (12 chars)" : null,
		source: present ? "file" : "none",
		shadowedByEnv: false,
	});
	const keys = AUTH_KEYS.map((key) => row(key.id, key.id === "BRAVE_API_KEY"));
	for (const [key, value] of Object.entries({
		window: dom.window,
		document: dom.document,
		navigator: globals.navigator ?? { userAgent: "", platform: "" },
		HTMLElement: dom.window.HTMLElement,
		Node: dom.window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/keys" && (!init || !init.method || init.method === "GET")) {
				return new Response(JSON.stringify({ keys, providers: [] }));
			}
			if (url === "/api/settings") return new Response(JSON.stringify({ settings: { version: 1 } }));
			if (url === "/api/custom-provider") return new Response("no", { status: 404 });
			if (url === "/api/claude-code") return new Response(JSON.stringify({ state: "not-found" }));
			throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => { root.render(<KeysSection />); });
		const urlRow = document.querySelector<HTMLElement>('[data-testid="key-firecrawl_api_url"]')!;
		assert.ok(urlRow.closest('[data-testid="group-search"]'));
		assert.equal(urlRow.closest('[data-testid="group-dictation"]'), null);
		assert.equal(urlRow.querySelector("a")?.textContent, "docs ↗");
		assert.match(urlRow.textContent ?? "", /not set/);
		assert.equal(info.secret, false);
		const brave = document.querySelector('[data-testid="key-brave_api_key"]')!;
		assert.ok(brave.closest('[data-testid="group-search"]'));
		assert.equal(brave.querySelector("a")?.textContent, "key ↗");
		assert.match(brave.textContent ?? "", /…ab12/);
		assert.ok(document.querySelector('[data-testid="key-firecrawl_api_key"]')?.closest('[data-testid="group-search"]'));
		await act(async () => { urlRow.querySelector("button")!.click(); });
		const input = document.querySelector<HTMLInputElement>('[data-testid="key-firecrawl_api_url-input"]')!;
		assert.equal(input.placeholder, "http://192.168.7.5:3002");
		assert.equal(input.getAttribute("aria-label"), "Firecrawl URL");
	} finally {
		act(() => { root.unmount(); });
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
});
