/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import './components/viewer.css';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getInitialState } from '../../webview/bridge';
import { ConfigProvider, theme } from 'antd';
import { AudioViewer } from './components/audioViewer';
import { ImageViewer } from './components/imageViewer';
import { VideoViewer } from './components/videoViewer';
import { ImageFrame, SampleFrame } from '../../webview/protocol';


type InitialState = {
    mediaType?: 'image' | 'audio' | 'video';
    image?: { frames: ImageFrame[]; width: number; height: number; totalFrames: number };
    audio?: { samples: SampleFrame[]; sampleRate: number; bitDepth: number; channels: number; totalSamples: number; totalRecords: number };
    video?: { frames: ImageFrame[]; width: number; height: number; fps: number; totalFrames: number };
    fileName?: string;
    error?: string;
};

function MediaViewerApp() {
    const initial = getInitialState<InitialState>({});

    if (initial.error) {
        return (
            <div className="error-page">
                <div className="error">
                    <h2>Media Viewer Error</h2>
                    <p>{initial.error}</p>
                </div>
            </div>
        );
    }

    let applet: React.ReactNode = null;
    if (initial.mediaType === 'image' && initial.image) { applet = <ImageViewer state={initial.image} filename={initial.fileName} />; }
    else if (initial.mediaType === 'audio' && initial.audio) { applet = <AudioViewer state={initial.audio} filename={initial.fileName} />; }
    else if (initial.mediaType === 'video' && initial.video) { applet = <VideoViewer state={initial.video} filename={initial.fileName} />; }
    else { applet = <div style={{ padding: 16 }}>No media content available.</div>; }

    return (
        <div className="page">
            {applet}
        </div>
    );
}

function ThemedViewerApp() {
    const getIsDarkTheme = () => {
        const classList = document.body.classList;
        return classList.contains('vscode-dark') || classList.contains('vscode-high-contrast');
    };

    const [isDarkTheme, setIsDarkTheme] = useState(getIsDarkTheme);

    useEffect(() => {
        const updateTheme = () => setIsDarkTheme(getIsDarkTheme());
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        updateTheme();

        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <ConfigProvider theme={{ algorithm: isDarkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
            <MediaViewerApp />
        </ConfigProvider>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ThemedViewerApp />);
}
