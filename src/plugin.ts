import streamDeck from "@elgato/streamdeck";

import { AgentAction, ApproveAction, DenyAction, NextWaitingAction, ShowOrcaAction, UsageAction } from "./actions";
import { controller } from "./controller";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new AgentAction());
streamDeck.actions.registerAction(new NextWaitingAction());
streamDeck.actions.registerAction(new ShowOrcaAction());
streamDeck.actions.registerAction(new ApproveAction());
streamDeck.actions.registerAction(new DenyAction());
streamDeck.actions.registerAction(new UsageAction());

await streamDeck.connect();
await controller.init();
