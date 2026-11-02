/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 TripleScreen contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { ApplicationCommandInputType } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Link } from "@components/Link";
import { Logger } from "@utils/Logger";
import definePlugin, { IconComponent, PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { displayCaptureManager } from "./capture/DisplayCaptureManager";
import { settings } from "./settings";
import { discordStreamAdapter } from "./streaming/DiscordStreamAdapter";
import { installGoLiveGuard, uninstallGoLiveGuard } from "./streaming/GoLiveGuard";
import { installStreamPickerTab, setStreamPickerOpener, uninstallStreamPickerTab } from "./ui/StreamPickerTab";
import { openTripleScreenModal } from "./ui/TripleScreenModal";

const logger = new Logger("TripleScreen");

const Native = (typeof VencordNative !== "undefined"
    ? VencordNative.pluginHelpers.TripleScreen
    : null) as PluginNative<typeof import("./native")> | null;

function openConfigurator() {
    openTripleScreenModal();
}

const TripleScreenIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        width={width}
        height={height}
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
    >
        <rect x="2" y="5" width="6.5" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="8.75" y="4" width="6.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="15.5" y="5" width="6.5" height="11" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M7 19h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
);

const TripleScreenChatButton: ChatBarButtonFactory = ({ isMainChat }) => {
    if (!isMainChat || !settings.store.showChatBarButton) return null;
    return (
        <ChatBarButton tooltip="TripleScreen — share multiple monitors" onClick={openConfigurator}>
            <TripleScreenIcon />
        </ChatBarButton>
    );
};

function isVoiceLikeChannel(channel?: Channel | null) {
    if (!channel) return false;
    const type = Number((channel as Channel & { type?: number; }).type);
    return type === 2 || type === 13 || !!(channel as Channel & { isVocal?: () => boolean; }).isVocal?.();
}

const voiceContextPatch: NavContextMenuPatchCallback = (children, _props) => {
    children.push(
        <Menu.MenuItem
            id="triplescreen-share-multi"
            label="Share Multiple Monitors"
            action={openConfigurator}
        />
    );
};

const channelContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const channel = (props as { channel?: Channel; })?.channel;
    if (!isVoiceLikeChannel(channel)) return;
    children.push(
        <Menu.MenuItem
            id="triplescreen-share-multi-channel"
            label="Share Multiple Monitors"
            action={openConfigurator}
        />
    );
};

export default definePlugin({
    name: "TripleScreen",
    description: "Capture multiple monitors, arrange them on a custom canvas, and share one composite stream through Discord.",
    authors: [{ name: "TripleScreen", id: 0n }],
    tags: ["Voice", "Utility", "Media"],
    settings,
    dependencies: ["ChatInputButtonAPI"],
    settingsAboutComponent: () => (
        <div style={{ display: "grid", gap: 8 }}>
            <span>
                TripleScreen composites selected displays into one Discord Go Live stream. Viewers do not need the plugin.
            </span>
            <span>
                System audio (Windows): the Output window mirrors your desktop mix without Discord (so friends
                do not hear themselves). You are briefly deafened in VC while streaming so call audio is not
                captured. Minimize parks the Output; the mosaic keeps streaming.
            </span>
            <span>
                Open Discord&apos;s Screen Share picker → TripleScreen tab, a voice-channel menu, the Vencord toolbox, or /triplescreen.
            </span>
            <Link href="https://docs.vencord.dev/installing/custom-plugins/">Vencord custom plugin install guide</Link>
        </div>
    ),

    commands: [
        {
            name: "triplescreen",
            description: "Open the TripleScreen multi-monitor layout editor",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: () => {
                openConfigurator();
            }
        }
    ],

    contextMenus: {
        "audio-device-context": voiceContextPatch,
        "audio-context": voiceContextPatch,
        "channel-context": channelContextPatch,
        "gdm-context": channelContextPatch
    },

    toolboxActions: {
        "TripleScreen layout": openConfigurator
    },

    chatBarButton: {
        icon: TripleScreenIcon,
        render: TripleScreenChatButton
    },

    async start() {
        try {
            setStreamPickerOpener(openConfigurator);
            installGoLiveGuard();
            installStreamPickerTab();
            if (Native) {
                const info = await Native.getRuntimeInfo();
                logger.info("Native runtime", info);
            } else {
                logger.info("Running without native helpers (web or helpers unavailable)");
            }
        } catch (err) {
            logger.error("TripleScreen start failed — normal Discord screen share remains available", err);
        }
    },

    async stop() {
        try {
            await discordStreamAdapter.stop();
        } catch (err) {
            logger.warn("Error while stopping TripleScreen", err);
        }
        uninstallStreamPickerTab();
        uninstallGoLiveGuard();
        displayCaptureManager.stopCapture();
    }
});
