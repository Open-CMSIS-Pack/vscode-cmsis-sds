/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebviewMessenger, getInitialState } from '../../webview/bridge';
import { SdsRecorderConfig } from '../../sds';
import { WebviewMessage } from '../../webview/protocol';

type RecorderMode = 'usb' | 'serial' | 'socket' | 'demo';

interface SerialPortsMessage extends WebviewMessage {
    type: 'serialPorts';
    ports: string[];
}

interface RecordingStartedMessage extends WebviewMessage {
    type: 'recordingStarted';
    isHardwareMode?: boolean;
}

interface RecordingStoppedMessage extends WebviewMessage {
    type: 'recordingStopped';
    recordCount: number;
    totalBytes: number;
    outputFile: string;
}

interface RecordingStatusMessage extends WebviewMessage {
    type: 'recordingStatus';
    recordCount: number;
    totalBytes: number;
    elapsed?: number;
    streams?: { name: string; filePath: string }[];
}

interface ServerStateChangedMessage extends WebviewMessage {
    type: 'serverStateChanged';
    state: string;
}

interface ServerEventMessage extends WebviewMessage {
    type: 'serverEvent';
    event?: { type: string; message: string; streamName?: string; filePath?: string };
}

type InboundMessage =
    | SerialPortsMessage
    | RecordingStartedMessage
    | RecordingStoppedMessage
    | RecordingStatusMessage
    | ServerStateChangedMessage
    | ServerEventMessage
    | WebviewMessage;

type OutboundMessage =
    | ({ command: 'startRecording'; config: SdsRecorderConfig } & WebviewMessage)
    | ({ command: 'stopRecording' } & WebviewMessage)
    | ({ command: 'getSerialPorts' } & WebviewMessage)
    | ({ command: 'getServerState' } & WebviewMessage)
    | WebviewMessage;

type RecorderInitialState = {
    defaultPort: string;
    defaultBaud: number;
    defaultDir: string;
};

const messenger = new WebviewMessenger<InboundMessage, OutboundMessage>();

const styles = {
    page: { background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 13, padding: 20 } as React.CSSProperties,
    section: { border: '1px solid var(--vscode-panel-border)', borderRadius: 6, padding: 16, marginBottom: 16 } as React.CSSProperties,
    h1: { fontSize: 18, marginBottom: 20 } as React.CSSProperties,
    h2: { fontSize: 14, marginBottom: 12, opacity: 0.9 } as React.CSSProperties,
    formRow: { display: 'flex', gap: 12 } as React.CSSProperties,
    formGroup: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12, flex: 1 } as React.CSSProperties,
    label: { fontSize: 11, opacity: 0.8, textTransform: 'uppercase', letterSpacing: 0.5 } as React.CSSProperties,
    input: { background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', padding: '6px 10px', borderRadius: 3, fontSize: 13, fontFamily: 'inherit' } as React.CSSProperties,
    select: { background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)', padding: '6px 10px', borderRadius: 3, fontSize: 13, fontFamily: 'inherit' } as React.CSSProperties,
    button: { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', padding: '8px 20px', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' } as React.CSSProperties,
    buttonDisabled: { background: 'var(--vscode-button-disabledBackground)', color: 'var(--vscode-button-disabledForeground)', border: 'none', padding: '8px 20px', borderRadius: 4, fontSize: 13, fontFamily: 'inherit', cursor: 'not-allowed', opacity: 0.6 } as React.CSSProperties,
    buttonSecondary: { background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', border: 'none', padding: '6px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' } as React.CSSProperties,
    controls: { display: 'flex', gap: 12, alignItems: 'center' } as React.CSSProperties,
    statusPanel: { marginTop: 16 } as React.CSSProperties,
    statusGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 } as React.CSSProperties,
    statusItem: { padding: '8px 12px', borderRadius: 4, background: 'rgba(128,128,128,0.1)' } as React.CSSProperties,
    logPanel: { marginTop: 12, maxHeight: 200, overflowY: 'auto', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--vscode-panel-border)', borderRadius: 4, padding: 8, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 12, lineHeight: 1.5 } as React.CSSProperties,
};
// Add a style for disabled elements

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function RecorderApp() {
    const initial = getInitialState<RecorderInitialState>({ defaultPort: '', defaultBaud: 115200, defaultDir: './sds_recordings' });

    const [mode, setMode] = useState<RecorderMode>('usb');
    const [serialPorts, setSerialPorts] = useState<string[]>([]);
    const [serialPort, setSerialPort] = useState<string>(initial.defaultPort || '');
    const [manualSerialPort, setManualSerialPort] = useState<string>('');
    const [baudRate, setBaudRate] = useState<number>(initial.defaultBaud || 115200);
    const [ipAddress, setIpAddress] = useState<string>('127.0.0.1');
    const [tcpPort, setTcpPort] = useState<number>(5050);
    const [streamName, setStreamName] = useState<string>('Sensors');
    const [frequency, setFrequency] = useState<number>(100);
    const [channels, setChannels] = useState<string>('x, y, z');
    const [outputDir, setOutputDir] = useState<string>(initial.defaultDir || './sds_recordings');

    const [serverState, setServerState] = useState<string>('stopped');
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [isHardwareMode, setIsHardwareMode] = useState<boolean>(true);
    const [recordCount, setRecordCount] = useState<number>(0);
    const [totalBytes, setTotalBytes] = useState<number>(0);
    const [startTimestamp, setStartTimestamp] = useState<number | undefined>(undefined);
    const [streams, setStreams] = useState<Array<{ name: string; filePath: string }>>([]);
    const [logs, setLogs] = useState<Array<{ text: string; cls?: 'error' | 'stream' }>>([]);

    const elapsedMs = useMemo(() => {
        if (!startTimestamp) { return 0; }
        return Date.now() - startTimestamp;
    }, [startTimestamp, recordCount, totalBytes]);

    useEffect(() => {
        const offPorts = messenger.on('serialPorts', msg => {
            if (Array.isArray(msg.ports)) {
                setSerialPorts(msg.ports);
            } else {
                setSerialPorts([]);
            }
        });
        const offStarted = messenger.on('recordingStarted', msg => {
            setIsRecording(true);
            setStartTimestamp(Date.now());
            setRecordCount(0);
            setTotalBytes(0);
            setStreams([]);
            setLogs([]);
            setIsHardwareMode(msg.isHardwareMode !== undefined ? !!msg.isHardwareMode : mode !== 'demo');
        });
        const offStopped = messenger.on('recordingStopped', () => {
            setIsRecording(false);
            setServerState('stopped');
        });
        const offStatus = messenger.on('recordingStatus', msg => {
            if ('recordCount' in msg) { setRecordCount(msg?.recordCount as number || 0); }
            if ('totalBytes' in msg) { setTotalBytes(msg?.totalBytes as number || 0); }
            if (Array.isArray(msg.streams)) { setStreams(msg.streams); }
        });
        const offState = messenger.on('serverStateChanged', msg => {
            if ('state' in msg) { setServerState(String(msg.state)); }
        });
        const offEvent = messenger.on('serverEvent', msg => {
            const evt = msg.event;
            if (
                !evt ||
                typeof evt !== 'object' ||
                typeof (evt as WebviewMessage).message !== 'string' ||
                typeof (evt as WebviewMessage).type !== 'string'
            ) {
                return;
            }
            setLogs(prev => {
                const text = (evt as WebviewMessage).message || '';
                const eventType = (evt as WebviewMessage).type;
                const cls: 'error' | 'stream' | undefined =
                    eventType === 'error' ? 'error' :
                        (eventType === 'stream-open' || eventType === 'stream-close') ? 'stream' : undefined;
                const next = [...prev, { text, cls }];
                if (next.length > 200) { next.shift(); }
                return next;
            });
        });

        messenger.send({ command: 'getServerState' });
        //return () => { offPorts(); offStarted(); offStopped(); offStatus(); offState(); offEvent(); messenger.dispose(); };
        return () => { offPorts(); offStarted(); offStopped(); offStatus(); offState(); offEvent(); };
    }, [mode]);

    useEffect(() => {
        if (mode === 'serial') {
            messenger.send({ command: 'getSerialPorts' });
        }
    }, [mode]);

    const serverStateLabel = useMemo(() => {
        const labels: Record<string, string> = {
            stopped: 'Stopped',
            starting: 'Starting...',
            waiting: 'Waiting for device...',
            connected: 'Device connected',
            recording: 'Recording data',
            error: 'Error',
        };
        return labels[serverState] ?? serverState;
    }, [serverState]);

    const canStart = !isRecording && (mode !== 'serial' ? true : mode === 'serial' && (serialPort.trim() !== '' || manualSerialPort.trim() !== ''));
    const canStop = isRecording;

    function startRecording() {
        const channelList = channels.split(',').map(s => s.trim()).filter(Boolean);
        const serial = manualSerialPort.trim() || serialPort;
        setStartTimestamp(Date.now());
        messenger.send({
            command: 'startRecording',
            config: {
                mode,
                streamName: mode === 'demo' ? (streamName || 'Recording') : undefined,
                serialPort: serial,
                baudRate: baudRate,
                ipAddress: ipAddress,
                tcpPort: tcpPort,
                frequency: frequency || 100,
                channels: channelList.length > 0 ? channelList : ['x', 'y', 'z'],
                outputDirectory: outputDir,
            },
        });
    }

    function stopRecording() {
        messenger.send({ command: 'stopRecording' });
    }

    return (
        <div style={styles.page}>
            <style>{`@keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }`}</style>
            <h1 style={styles.h1}>⏺ SDS Recorder</h1>

            <div style={styles.section}>
                <h2 style={styles.h2}>Connection Settings</h2>
                <div style={styles.formRow}>
                    <div style={styles.formGroup}>
                        <label style={styles.label}>Mode</label>
                        <select style={styles.select} value={mode} onChange={e => setMode(e.target.value as RecorderMode)}>
                            <option value="usb">USB (Bulk)</option>
                            <option value="serial">Serial (UART)</option>
                            <option value="socket">Socket (TCP/IP)</option>
                            <option value="demo">Demo Signal (Sinewave)</option>
                        </select>
                    </div>
                </div>

                {mode === 'serial' && (
                    <div>
                        <div style={styles.formRow}>
                            <div style={styles.formGroup}>
                                <label style={styles.label}>Serial Port</label>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <select style={{ ...styles.select, flex: 1 }} value={serialPort} onChange={e => setSerialPort(e.target.value)} disabled={manualSerialPort.trim() !== ''}>
                                        <option value="">Select port...</option>
                                        {serialPorts.map(p => (
                                            <option key={p} value={p}>{p}</option>
                                        ))}
                                    </select>
                                    <button style={styles.buttonSecondary} onClick={() => messenger.send({ command: 'getSerialPorts' })} title="Refresh ports">↻</button>
                                </div>
                                <input
                                    style={{ ...styles.input, marginTop: 4 }}
                                    type="search"
                                    placeholder="Or enter manually (e.g. /dev/ttyACM0)"
                                    value={manualSerialPort}
                                    onChange={e => setManualSerialPort(e.target.value)}
                                />
                            </div>
                            <div style={styles.formGroup}>
                                <label style={styles.label}>Baud Rate</label>
                                <select style={styles.select} value={baudRate} onChange={e => setBaudRate(parseInt(e.target.value, 10))}>
                                    {[9600, 115200, 230400, 460800, 921600].map(v => (
                                        <option key={v} value={v}>{v}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                )}

                {mode === 'socket' && (
                    <div style={styles.formRow}>
                        <div style={styles.formGroup}>
                            <label style={styles.label}>IP Address</label>
                            <input style={styles.input} value={ipAddress} onChange={e => setIpAddress(e.target.value)} />
                        </div>
                        <div style={styles.formGroup}>
                            <label style={styles.label}>TCP Port</label>
                            <input style={styles.input} type="number" value={tcpPort} onChange={e => setTcpPort(parseInt(e.target.value, 10) || 0)} />
                        </div>
                    </div>
                )}

                {mode === 'demo' && (
                    <div style={styles.formRow}>
                        <div style={styles.formGroup}>
                            <label style={styles.label}>Stream Name</label>
                            <input style={styles.input} value={streamName} onChange={e => setStreamName(e.target.value)} />
                        </div>
                        <div style={styles.formGroup}>
                            <label style={styles.label}>Frequency (Hz)</label>
                            <input style={styles.input} type="number" value={frequency} min={1} max={10000} onChange={e => setFrequency(parseInt(e.target.value, 10) || 0)} />
                        </div>
                        <div style={styles.formGroup}>
                            <label style={styles.label}>Channels</label>
                            <input style={styles.input} value={channels} onChange={e => setChannels(e.target.value)} placeholder="Comma-separated" />
                        </div>
                    </div>
                )}

                <div style={styles.formGroup}>
                    <label style={styles.label}>Output Directory</label>
                    <input style={styles.input} value={outputDir} onChange={e => setOutputDir(e.target.value)} />
                </div>
            </div>

            <div style={styles.section}>
                <div style={styles.controls}>
                    <button style={{ ...(canStart ? styles.button : styles.buttonDisabled), background: '#d32f2f', color: '#fff', fontWeight: 'bold', fontSize: 14, padding: '10px 32px' }} onClick={startRecording} disabled={!canStart}>⏺ Start Recording</button>
                    <button style={{ ...(canStop ? styles.button : styles.buttonDisabled), background: '#555', color: '#fff', fontSize: 14, padding: '10px 32px' }} onClick={stopRecording} disabled={!canStop}>⏹ Stop</button>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: serverState === 'recording' ? '#d32f2f' : serverState === 'connected' ? '#4caf50' : serverState === 'waiting' || serverState === 'starting' ? '#ff9800' : serverState === 'error' ? '#d32f2f' : '#888', animation: serverState === 'recording' ? 'pulse 0.5s infinite' : serverState === 'waiting' ? 'pulse 1s infinite' : undefined }} />
                        <span>{serverStateLabel}</span>
                    </span>
                </div>

                {isRecording && (
                    <div style={styles.statusPanel}>
                        <h2 style={styles.h2}><span style={{ display: 'inline-block', width: 10, height: 10, background: '#d32f2f', borderRadius: '50%', animation: 'pulse 1s infinite', marginRight: 8 }}></span>{isHardwareMode ? 'Server running' : 'Recording in progress...'}</h2>
                        <div style={styles.statusGrid}>
                            <div style={styles.statusItem}>
                                <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase' }}>{isHardwareMode ? 'Streams' : 'Records'}</div>
                                <div style={{ fontSize: 16, fontWeight: 600 }}>{recordCount}</div>
                            </div>
                            <div style={styles.statusItem}>
                                <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase' }}>Total Size</div>
                                <div style={{ fontSize: 16, fontWeight: 600 }}>{formatBytes(totalBytes)}</div>
                            </div>
                            <div style={styles.statusItem}>
                                <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase' }}>Elapsed</div>
                                <div style={{ fontSize: 16, fontWeight: 600 }}>{(elapsedMs / 1000).toFixed(1)}s</div>
                            </div>
                            <div style={styles.statusItem}>
                                <div style={{ fontSize: 10, opacity: 0.7, textTransform: 'uppercase' }}>Data Rate</div>
                                <div style={{ fontSize: 16, fontWeight: 600 }}>{formatBytes(elapsedMs > 0 ? Math.round(totalBytes / (elapsedMs / 1000)) : 0)}/s</div>
                            </div>
                        </div>

                        {streams.length > 0 && (
                            <ul style={{ marginTop: 8, padding: 0, listStyle: 'none' }}>
                                {streams.map(s => (
                                    <li key={s.filePath} style={{ padding: '4px 8px', borderRadius: 3, background: 'rgba(76,175,80,0.1)', marginBottom: 4, fontSize: 12 }}>
                                        📡 {s.name} → {s.filePath}
                                    </li>
                                ))}
                            </ul>
                        )}

                        {isHardwareMode && (
                            <div style={styles.logPanel}>
                                {logs.map((l, idx) => (
                                    <div key={idx} style={{ color: l.cls === 'error' ? 'var(--vscode-errorForeground)' : l.cls === 'stream' ? '#4caf50' : 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l.text}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<RecorderApp />);
}
