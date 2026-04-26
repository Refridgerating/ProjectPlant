#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialize SNTP time synchronization service.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
esp_err_t time_sync_init(void);

/**
 * Wait until the system clock has been synchronized to a valid epoch.
 *
 * @param timeout_ticks Maximum time to wait (FreeRTOS ticks). Pass portMAX_DELAY to wait indefinitely.
 * @return true if time became valid before timeout, false otherwise.
 */
bool time_sync_wait_for_valid(TickType_t timeout_ticks);

/**
 * Returns true when the current system time is considered valid.
 */
bool time_sync_is_time_valid(void);

/**
 * Set the process-local timezone used by localtime_r.
 *
 * Pass NULL or an empty string to restore UTC.
 */
esp_err_t time_sync_set_timezone(const char *timezone_posix);

/**
 * Returns the current timezone offset in minutes, including DST when active.
 */
bool time_sync_get_timezone_offset_minutes(int16_t *out_offset_minutes);

#ifdef __cplusplus
}
#endif
