export declare const deviceCommandPayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    properties: {
        requestId: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        request_id: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        action: {
            type: string;
            enum: string[];
        };
        command: {
            type: string;
            enum: string[];
        };
        pump: {
            $ref: string;
        };
        icZone1: {
            $ref: string;
        };
        ic_zone1: {
            $ref: string;
        };
        fan: {
            $ref: string;
        };
        mister: {
            $ref: string;
        };
        light: {
            $ref: string;
        };
        duration_ms: {
            type: string;
            minimum: number;
        };
        deviceName: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        displayName: {
            type: string;
            minLength: number;
            maxLength: number;
        };
        sensorMode: {
            type: string;
            enum: string[];
        };
        sensor_mode: {
            type: string;
            enum: string[];
        };
        sensorsEnabled: {
            type: string;
        };
        schedule: {
            $ref: string;
        };
        tzOffsetMinutes: {
            type: string;
        };
        scheduleTimezonePosix: {
            type: string;
            minLength: number;
        };
        scheduleUpdatedAtMs: {
            type: string;
            minimum: number;
        };
        updatedAtMs: {
            type: string;
            minimum: number;
        };
    };
    anyOf: {
        required: string[];
    }[];
    definitions: {
        actuatorValue: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
    };
};
export declare const deviceSchedulePayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    properties: {
        light: {
            $ref: string;
        };
        pump: {
            $ref: string;
        };
        icZone1: {
            $ref: string;
        };
        ic_zone1: {
            $ref: string;
        };
        mister: {
            $ref: string;
        };
        fan: {
            $ref: string;
        };
        tzOffsetMinutes: {
            type: string;
        };
        scheduleTimezonePosix: {
            type: string;
            minLength: number;
        };
        scheduleUpdatedAtMs: {
            type: string;
            minimum: number;
        };
        updatedAtMs: {
            type: string;
            minimum: number;
        };
    };
    definitions: {
        timer: {
            type: string;
            additionalProperties: boolean;
            required: string[];
            properties: {
                enabled: {
                    type: string;
                };
                startTime: {
                    type: string;
                    pattern: string;
                };
                endTime: {
                    type: string;
                    pattern: string;
                };
            };
        };
    };
};
export declare const deviceSensorPayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    required: string[];
    properties: {
        potId: {
            type: string;
            minLength: number;
        };
        moisture: {
            type: string;
        };
        temperature: {
            type: string;
        };
        humidity: {
            type: string;
        };
        valveOpen: {
            type: string;
        };
        icZone1On: {
            type: string;
        };
        fanOn: {
            type: string;
        };
        misterOn: {
            type: string;
        };
        lightOn: {
            type: string;
        };
        flowRateLpm: {
            type: string;
        };
        waterLow: {
            type: string;
        };
        waterCutoff: {
            type: string;
        };
        soilRaw: {
            type: string;
        };
        timestamp: {
            type: string;
            minLength: number;
        };
        timestampMs: {
            type: string;
            minimum: number;
        };
        requestId: {
            type: string;
            minLength: number;
        };
        deviceName: {
            type: string;
        };
        displayName: {
            type: string;
        };
        isNamed: {
            type: string;
        };
        sensorMode: {
            type: string;
        };
        source: {
            type: string;
        };
    };
};
export declare const deviceStatusPayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    properties: {
        potId: {
            type: string;
            minLength: number;
        };
        status: {
            type: string;
            minLength: number;
        };
        state: {
            type: string;
            minLength: number;
        };
        fwVersion: {
            type: string;
        };
        requestId: {
            type: string;
            minLength: number;
        };
        request_id: {
            type: string;
            minLength: number;
        };
        timestamp: {
            type: string;
            minLength: number;
        };
        timestampMs: {
            type: string;
            minimum: number;
        };
        timestamp_ms: {
            type: string;
            minimum: number;
        };
        pumpOn: {
            type: string;
        };
        pump_on: {
            type: string;
        };
        pump: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        icZone1On: {
            type: string;
        };
        ic_zone1_on: {
            type: string;
        };
        icZone1: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        ic_zone1: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        fanOn: {
            type: string;
        };
        fan_on: {
            type: string;
        };
        fan: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        misterOn: {
            type: string;
        };
        mister_on: {
            type: string;
        };
        mister: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        lightOn: {
            type: string;
        };
        light_on: {
            type: string;
        };
        light: {
            anyOf: ({
                type: string;
                enum?: undefined;
            } | {
                type: string;
                enum: string[];
            })[];
        };
        deviceName: {
            type: string;
        };
        displayName: {
            type: string;
        };
        isNamed: {
            type: string;
        };
        sensorMode: {
            type: string;
        };
        sensor_mode: {
            type: string;
        };
        schedule: {
            $ref: string;
        };
        schedulePaused: {
            type: string;
        };
        schedulePausedUntilMs: {
            anyOf: ({
                type: string;
                minimum: number;
            } | {
                type: string;
                minimum?: undefined;
            })[];
        };
        scheduleUpdatedAtMs: {
            type: string;
            minimum: number;
        };
        scheduleTimezonePosix: {
            type: string;
        };
        schedule_timezone_posix: {
            type: string;
        };
        tzOffsetMinutesCurrent: {
            type: string;
        };
        tz_offset_minutes_current: {
            type: string;
        };
    };
    anyOf: {
        required: string[];
    }[];
};
export declare const legacyFirmwareTelemetryPayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    properties: {
        device_id: {
            type: string;
        };
        potId: {
            type: string;
        };
        soil_pct: {
            anyOf: {
                type: string;
            }[];
        };
        moisture: {
            anyOf: {
                type: string;
            }[];
        };
        temperature_c: {
            anyOf: {
                type: string;
            }[];
        };
        temperature: {
            anyOf: {
                type: string;
            }[];
        };
        humidity_pct: {
            anyOf: {
                type: string;
            }[];
        };
        humidity: {
            anyOf: {
                type: string;
            }[];
        };
        pump_on: {
            anyOf: {
                type: string;
            }[];
        };
        valveOpen: {
            anyOf: {
                type: string;
            }[];
        };
        icZone1On: {
            anyOf: {
                type: string;
            }[];
        };
        ic_zone1_on: {
            anyOf: {
                type: string;
            }[];
        };
        fanOn: {
            anyOf: {
                type: string;
            }[];
        };
        fan_on: {
            anyOf: {
                type: string;
            }[];
        };
        misterOn: {
            anyOf: {
                type: string;
            }[];
        };
        mister_on: {
            anyOf: {
                type: string;
            }[];
        };
        lightOn: {
            anyOf: {
                type: string;
            }[];
        };
        light_on: {
            anyOf: {
                type: string;
            }[];
        };
        timestamp_ms: {
            anyOf: {
                type: string;
            }[];
        };
        timestampMs: {
            anyOf: {
                type: string;
            }[];
        };
        timestamp: {
            type: string;
        };
        requestId: {
            type: string;
        };
        request_id: {
            type: string;
        };
    };
};
export declare const legacyFirmwareStatusPayloadSchema: {
    $id: string;
    $schema: string;
    title: string;
    type: string;
    additionalProperties: boolean;
    properties: {
        status: {
            type: string;
        };
        state: {
            type: string;
        };
        requestId: {
            type: string;
        };
        request_id: {
            type: string;
        };
        timestamp: {
            type: string;
        };
        timestampMs: {
            anyOf: {
                type: string;
            }[];
        };
        timestamp_ms: {
            anyOf: {
                type: string;
            }[];
        };
        pump_on: {
            anyOf: {
                type: string;
            }[];
        };
        pumpOn: {
            anyOf: {
                type: string;
            }[];
        };
        pump: {
            anyOf: {
                type: string;
            }[];
        };
        icZone1On: {
            anyOf: {
                type: string;
            }[];
        };
        ic_zone1_on: {
            anyOf: {
                type: string;
            }[];
        };
        fan_on: {
            anyOf: {
                type: string;
            }[];
        };
        fanOn: {
            anyOf: {
                type: string;
            }[];
        };
        mister_on: {
            anyOf: {
                type: string;
            }[];
        };
        misterOn: {
            anyOf: {
                type: string;
            }[];
        };
        light_on: {
            anyOf: {
                type: string;
            }[];
        };
        lightOn: {
            anyOf: {
                type: string;
            }[];
        };
        schedule: {
            $ref: string;
        };
    };
};
export declare const protocolSchemas: {
    readonly deviceCommandPayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            requestId: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            request_id: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            action: {
                type: string;
                enum: string[];
            };
            command: {
                type: string;
                enum: string[];
            };
            pump: {
                $ref: string;
            };
            icZone1: {
                $ref: string;
            };
            ic_zone1: {
                $ref: string;
            };
            fan: {
                $ref: string;
            };
            mister: {
                $ref: string;
            };
            light: {
                $ref: string;
            };
            duration_ms: {
                type: string;
                minimum: number;
            };
            deviceName: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            displayName: {
                type: string;
                minLength: number;
                maxLength: number;
            };
            sensorMode: {
                type: string;
                enum: string[];
            };
            sensor_mode: {
                type: string;
                enum: string[];
            };
            sensorsEnabled: {
                type: string;
            };
            schedule: {
                $ref: string;
            };
            tzOffsetMinutes: {
                type: string;
            };
            scheduleTimezonePosix: {
                type: string;
                minLength: number;
            };
            scheduleUpdatedAtMs: {
                type: string;
                minimum: number;
            };
            updatedAtMs: {
                type: string;
                minimum: number;
            };
        };
        anyOf: {
            required: string[];
        }[];
        definitions: {
            actuatorValue: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
        };
    };
    readonly deviceSchedulePayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            light: {
                $ref: string;
            };
            pump: {
                $ref: string;
            };
            icZone1: {
                $ref: string;
            };
            ic_zone1: {
                $ref: string;
            };
            mister: {
                $ref: string;
            };
            fan: {
                $ref: string;
            };
            tzOffsetMinutes: {
                type: string;
            };
            scheduleTimezonePosix: {
                type: string;
                minLength: number;
            };
            scheduleUpdatedAtMs: {
                type: string;
                minimum: number;
            };
            updatedAtMs: {
                type: string;
                minimum: number;
            };
        };
        definitions: {
            timer: {
                type: string;
                additionalProperties: boolean;
                required: string[];
                properties: {
                    enabled: {
                        type: string;
                    };
                    startTime: {
                        type: string;
                        pattern: string;
                    };
                    endTime: {
                        type: string;
                        pattern: string;
                    };
                };
            };
        };
    };
    readonly deviceSensorPayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
            potId: {
                type: string;
                minLength: number;
            };
            moisture: {
                type: string;
            };
            temperature: {
                type: string;
            };
            humidity: {
                type: string;
            };
            valveOpen: {
                type: string;
            };
            icZone1On: {
                type: string;
            };
            fanOn: {
                type: string;
            };
            misterOn: {
                type: string;
            };
            lightOn: {
                type: string;
            };
            flowRateLpm: {
                type: string;
            };
            waterLow: {
                type: string;
            };
            waterCutoff: {
                type: string;
            };
            soilRaw: {
                type: string;
            };
            timestamp: {
                type: string;
                minLength: number;
            };
            timestampMs: {
                type: string;
                minimum: number;
            };
            requestId: {
                type: string;
                minLength: number;
            };
            deviceName: {
                type: string;
            };
            displayName: {
                type: string;
            };
            isNamed: {
                type: string;
            };
            sensorMode: {
                type: string;
            };
            source: {
                type: string;
            };
        };
    };
    readonly deviceStatusPayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            potId: {
                type: string;
                minLength: number;
            };
            status: {
                type: string;
                minLength: number;
            };
            state: {
                type: string;
                minLength: number;
            };
            fwVersion: {
                type: string;
            };
            requestId: {
                type: string;
                minLength: number;
            };
            request_id: {
                type: string;
                minLength: number;
            };
            timestamp: {
                type: string;
                minLength: number;
            };
            timestampMs: {
                type: string;
                minimum: number;
            };
            timestamp_ms: {
                type: string;
                minimum: number;
            };
            pumpOn: {
                type: string;
            };
            pump_on: {
                type: string;
            };
            pump: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            icZone1On: {
                type: string;
            };
            ic_zone1_on: {
                type: string;
            };
            icZone1: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            ic_zone1: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            fanOn: {
                type: string;
            };
            fan_on: {
                type: string;
            };
            fan: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            misterOn: {
                type: string;
            };
            mister_on: {
                type: string;
            };
            mister: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            lightOn: {
                type: string;
            };
            light_on: {
                type: string;
            };
            light: {
                anyOf: ({
                    type: string;
                    enum?: undefined;
                } | {
                    type: string;
                    enum: string[];
                })[];
            };
            deviceName: {
                type: string;
            };
            displayName: {
                type: string;
            };
            isNamed: {
                type: string;
            };
            sensorMode: {
                type: string;
            };
            sensor_mode: {
                type: string;
            };
            schedule: {
                $ref: string;
            };
            schedulePaused: {
                type: string;
            };
            schedulePausedUntilMs: {
                anyOf: ({
                    type: string;
                    minimum: number;
                } | {
                    type: string;
                    minimum?: undefined;
                })[];
            };
            scheduleUpdatedAtMs: {
                type: string;
                minimum: number;
            };
            scheduleTimezonePosix: {
                type: string;
            };
            schedule_timezone_posix: {
                type: string;
            };
            tzOffsetMinutesCurrent: {
                type: string;
            };
            tz_offset_minutes_current: {
                type: string;
            };
        };
        anyOf: {
            required: string[];
        }[];
    };
    readonly legacyFirmwareTelemetryPayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            device_id: {
                type: string;
            };
            potId: {
                type: string;
            };
            soil_pct: {
                anyOf: {
                    type: string;
                }[];
            };
            moisture: {
                anyOf: {
                    type: string;
                }[];
            };
            temperature_c: {
                anyOf: {
                    type: string;
                }[];
            };
            temperature: {
                anyOf: {
                    type: string;
                }[];
            };
            humidity_pct: {
                anyOf: {
                    type: string;
                }[];
            };
            humidity: {
                anyOf: {
                    type: string;
                }[];
            };
            pump_on: {
                anyOf: {
                    type: string;
                }[];
            };
            valveOpen: {
                anyOf: {
                    type: string;
                }[];
            };
            icZone1On: {
                anyOf: {
                    type: string;
                }[];
            };
            ic_zone1_on: {
                anyOf: {
                    type: string;
                }[];
            };
            fanOn: {
                anyOf: {
                    type: string;
                }[];
            };
            fan_on: {
                anyOf: {
                    type: string;
                }[];
            };
            misterOn: {
                anyOf: {
                    type: string;
                }[];
            };
            mister_on: {
                anyOf: {
                    type: string;
                }[];
            };
            lightOn: {
                anyOf: {
                    type: string;
                }[];
            };
            light_on: {
                anyOf: {
                    type: string;
                }[];
            };
            timestamp_ms: {
                anyOf: {
                    type: string;
                }[];
            };
            timestampMs: {
                anyOf: {
                    type: string;
                }[];
            };
            timestamp: {
                type: string;
            };
            requestId: {
                type: string;
            };
            request_id: {
                type: string;
            };
        };
    };
    readonly legacyFirmwareStatusPayload: {
        $id: string;
        $schema: string;
        title: string;
        type: string;
        additionalProperties: boolean;
        properties: {
            status: {
                type: string;
            };
            state: {
                type: string;
            };
            requestId: {
                type: string;
            };
            request_id: {
                type: string;
            };
            timestamp: {
                type: string;
            };
            timestampMs: {
                anyOf: {
                    type: string;
                }[];
            };
            timestamp_ms: {
                anyOf: {
                    type: string;
                }[];
            };
            pump_on: {
                anyOf: {
                    type: string;
                }[];
            };
            pumpOn: {
                anyOf: {
                    type: string;
                }[];
            };
            pump: {
                anyOf: {
                    type: string;
                }[];
            };
            icZone1On: {
                anyOf: {
                    type: string;
                }[];
            };
            ic_zone1_on: {
                anyOf: {
                    type: string;
                }[];
            };
            fan_on: {
                anyOf: {
                    type: string;
                }[];
            };
            fanOn: {
                anyOf: {
                    type: string;
                }[];
            };
            mister_on: {
                anyOf: {
                    type: string;
                }[];
            };
            misterOn: {
                anyOf: {
                    type: string;
                }[];
            };
            light_on: {
                anyOf: {
                    type: string;
                }[];
            };
            lightOn: {
                anyOf: {
                    type: string;
                }[];
            };
            schedule: {
                $ref: string;
            };
        };
    };
};
export type ActuatorValue = boolean | "on" | "off";
export interface DeviceScheduleTimer {
    enabled: boolean;
    startTime: string;
    endTime: string;
    [key: string]: unknown;
}
export interface DeviceSchedulePayload {
    light?: DeviceScheduleTimer;
    pump?: DeviceScheduleTimer;
    icZone1?: DeviceScheduleTimer;
    ic_zone1?: DeviceScheduleTimer;
    mister?: DeviceScheduleTimer;
    fan?: DeviceScheduleTimer;
    tzOffsetMinutes?: number;
    scheduleTimezonePosix?: string;
    scheduleUpdatedAtMs?: number;
    updatedAtMs?: number;
    [key: string]: unknown;
}
export interface DeviceCommandPayload {
    requestId?: string;
    request_id?: string;
    action?: "sensor_read" | "sensorRead";
    command?: "sensor_read" | "sensorRead";
    pump?: ActuatorValue;
    icZone1?: ActuatorValue;
    ic_zone1?: ActuatorValue;
    fan?: ActuatorValue;
    mister?: ActuatorValue;
    light?: ActuatorValue;
    duration_ms?: number;
    deviceName?: string;
    displayName?: string;
    sensorMode?: string;
    sensor_mode?: string;
    sensorsEnabled?: boolean;
    schedule?: DeviceSchedulePayload;
    tzOffsetMinutes?: number;
    scheduleTimezonePosix?: string;
    scheduleUpdatedAtMs?: number;
    updatedAtMs?: number;
    [key: string]: unknown;
}
export interface DeviceSensorPayload {
    potId: string;
    moisture: number;
    temperature: number;
    valveOpen: boolean;
    timestamp: string;
    humidity?: number;
    icZone1On?: boolean;
    fanOn?: boolean;
    misterOn?: boolean;
    lightOn?: boolean;
    flowRateLpm?: number;
    waterLow?: boolean;
    waterCutoff?: boolean;
    soilRaw?: number;
    timestampMs?: number;
    requestId?: string;
    deviceName?: string;
    displayName?: string;
    isNamed?: boolean;
    sensorMode?: string;
    source?: string;
    [key: string]: unknown;
}
export interface DeviceStatusPayload {
    potId?: string;
    status?: string;
    state?: string;
    fwVersion?: string;
    requestId?: string;
    request_id?: string;
    timestamp?: string;
    timestampMs?: number;
    timestamp_ms?: number;
    schedule?: DeviceSchedulePayload;
    [key: string]: unknown;
}
export type LegacyFirmwareTelemetryPayload = Record<string, unknown>;
export type LegacyFirmwareStatusPayload = Record<string, unknown>;
//# sourceMappingURL=schemas.d.ts.map