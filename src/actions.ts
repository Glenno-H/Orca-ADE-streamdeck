import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { type AgentSettings, controller, type UsageSettings } from "./controller";

export const PLUGIN_UUID = "au.gkw.orcadeck";

/** Messages every settings page can send: pairing, forgetting, and asking for the current status. */
async function handleCommon(payload: JsonObject | undefined): Promise<void> {
	if (payload?.event === "pair" && typeof payload.code === "string") {
		const error = await controller.pair(payload.code);
		await streamDeck.ui.sendToPropertyInspector({ event: "paired", error: error ?? "" });
	} else if (payload?.event === "forget") {
		await controller.forget();
	}
	await streamDeck.ui.sendToPropertyInspector(controller.describe());
}

/** Shows one agent: Auto picks whichever agent needs a key most; Pinned follows one worktree. */
@action({ UUID: `${PLUGIN_UUID}.agent` })
export class AgentAction extends SingletonAction<AgentSettings> {
	override onWillAppear(ev: WillAppearEvent<AgentSettings>): void {
		if (ev.action.isKey()) controller.addAgentKey(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<AgentSettings>): void {
		controller.removeKey(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<AgentSettings>): void {
		if (ev.action.isKey()) controller.updateAgentKey(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<AgentSettings>): Promise<void> {
		if (ev.action.isKey()) await controller.pressAgentKey(ev.action);
	}

	override async onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<AgentSettings>): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(controller.describe());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, AgentSettings>): Promise<void> {
		await handleCommon(ev.payload);
	}
}

/** Steps through the agents that are waiting on you, one per press. */
@action({ UUID: `${PLUGIN_UUID}.next` })
export class NextWaitingAction extends SingletonAction<JsonObject> {
	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		if (ev.action.isKey()) controller.addPlainKey(ev.action, "next");
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		controller.removeKey(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		if (ev.action.isKey()) await controller.pressNextWaiting(ev.action);
	}

	override async onPropertyInspectorDidAppear(): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(controller.describe());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, JsonObject>): Promise<void> {
		await handleCommon(ev.payload);
	}
}

/** Brings the Orca window to the front. */
@action({ UUID: `${PLUGIN_UUID}.show` })
export class ShowOrcaAction extends SingletonAction<JsonObject> {
	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		if (ev.action.isKey()) controller.addPlainKey(ev.action, "show");
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		controller.removeKey(ev.action.id);
	}

	override onKeyDown(ev: KeyDownEvent<JsonObject>): void {
		if (ev.action.isKey()) controller.pressShowOrca(ev.action);
	}

	override async onPropertyInspectorDidAppear(): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(controller.describe());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, JsonObject>): Promise<void> {
		await handleCommon(ev.payload);
	}
}

/** Shared Approve / Deny behaviour: answers the deck's last-jumped agent's permission request. */
abstract class ApprovalAction extends SingletonAction<JsonObject> {
	protected abstract readonly choice: "allow" | "deny";

	override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
		if (ev.action.isKey()) controller.addApprovalKey(ev.action, this.choice);
	}

	override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
		controller.removeKey(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
		if (ev.action.isKey()) await controller.pressApproval(ev.action, this.choice);
	}

	override async onPropertyInspectorDidAppear(): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(controller.describe());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, JsonObject>): Promise<void> {
		await handleCommon(ev.payload);
	}
}

/** Allows (once) the permission request of the agent the deck last jumped to. */
@action({ UUID: `${PLUGIN_UUID}.approve` })
export class ApproveAction extends ApprovalAction {
	protected readonly choice = "allow";
}

/** Denies the permission request of the agent the deck last jumped to. */
@action({ UUID: `${PLUGIN_UUID}.deny` })
export class DenyAction extends ApprovalAction {
	protected readonly choice = "deny";
}

/** Shows how much of the Claude or Codex limit is used, and when it resets. Press to refresh. */
@action({ UUID: `${PLUGIN_UUID}.usage` })
export class UsageAction extends SingletonAction<UsageSettings> {
	override onWillAppear(ev: WillAppearEvent<UsageSettings>): void {
		if (ev.action.isKey()) controller.addUsageKey(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<UsageSettings>): void {
		controller.removeKey(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<UsageSettings>): void {
		if (ev.action.isKey()) controller.addUsageKey(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
		if (ev.action.isKey()) await controller.pressUsage(ev.action);
	}

	override async onPropertyInspectorDidAppear(): Promise<void> {
		await streamDeck.ui.sendToPropertyInspector(controller.describe());
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonObject, UsageSettings>): Promise<void> {
		await handleCommon(ev.payload);
	}
}
