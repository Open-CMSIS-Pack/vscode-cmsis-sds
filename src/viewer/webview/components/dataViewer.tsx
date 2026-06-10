import React, { useMemo } from 'react';
import { BaseChartViewer, ChartSample } from './baseChartViewer';
import { Row, Col } from 'antd';

export interface DataViewerProps {
    samples: { timestamp: number; timeSeconds: number; values: Record<string, number> }[];
    channelNames: string[];
    title?: string;
}

export const DataViewer: React.FC<DataViewerProps> = ({ samples, channelNames, title }) => {
    // Flatten samples for AntD chart
    const chartData = useMemo<ChartSample[]>(() => {
        const data: ChartSample[] = [];
        for (const s of samples) {
            for (const ch of channelNames) {
                if (s.values[ch] !== undefined) {
                    data.push({
                        x: s.timeSeconds,
                        y: s.values[ch],
                        channel: ch,
                    });
                }
            }
        }
        return data;
    }, [samples, channelNames]);

    return (
        <div>
            <Row align="middle" style={{ marginBottom: 8 }}>
                <Col flex="auto">
                    <h3>{title || 'SDS Viewer'}</h3>
                </Col>
                {/* Add controls here as needed */}
            </Row>
            <BaseChartViewer
                data={chartData}
                xField="x"
                yField="y"
                seriesField="channel"
                height={320}
                title={title}
            />
            {/* Add zoom/slider controls here as needed */}
        </div>
    );
};
