#include "storage.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "esp_littlefs.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "sdkconfig.h"

static const char *TAG = "storage";

#define STORAGE_BASE_PATH "/storage"
#define STORAGE_FILE_PATH STORAGE_BASE_PATH "/telemetry.bin"
#define STORAGE_MAGIC 0x54524C47u  // 'TRLG'
#define STORAGE_VERSION 1u

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint16_t version;
    uint16_t capacity;
    uint32_t head;
    uint32_t tail;
    uint32_t count;
} storage_header_t;

typedef struct __attribute__((packed)) {
    uint64_t timestamp_ms;
    int64_t uptime_ms;
    int16_t rssi;
    uint16_t soil_raw;
    float soil_percent;
    float temperature_c;
    float humidity_pct;
    uint8_t water_low;
    uint8_t pump_on;
} storage_entry_t;

static SemaphoreHandle_t s_lock = NULL;
static FILE *s_file = NULL;
static storage_header_t s_header = {0};
static bool s_ready = false;

static uint16_t storage_get_capacity_config(void)
{
    uint16_t cap = CONFIG_PROJECTPLANT_RING_BUFFER_CAPACITY;
    if (cap == 0) {
        cap = 512;
    }
    return cap;
}

static size_t entry_offset(uint32_t index)
{
    return sizeof(storage_header_t) + index * sizeof(storage_entry_t);
}

static void storage_entry_from_sample(storage_entry_t *out, const telemetry_sample_t *sample)
{
    memset(out, 0, sizeof(*out));
    out->timestamp_ms = sample->reading.timestamp_ms;
    out->uptime_ms = sample->uptime_ms;
    out->rssi = sample->rssi;
    out->soil_raw = sample->reading.soil_raw;
    out->soil_percent = sample->reading.soil_percent;
    out->temperature_c = sample->reading.temperature_c;
    out->humidity_pct = sample->reading.humidity_pct;
    out->water_low = sample->reading.water_low ? 1 : 0;
    out->pump_on = sample->reading.pump_is_on ? 1 : 0;
}

static void storage_entry_to_sample(const storage_entry_t *entry, telemetry_sample_t *out)
{
    memset(out, 0, sizeof(*out));
    out->reading.timestamp_ms = entry->timestamp_ms;
    out->uptime_ms = entry->uptime_ms;
    out->rssi = entry->rssi;
    out->reading.soil_raw = entry->soil_raw;
    out->reading.soil_percent = entry->soil_percent;
    out->reading.temperature_c = entry->temperature_c;
    out->reading.humidity_pct = entry->humidity_pct;
    out->reading.water_low = entry->water_low != 0;
    out->reading.pump_is_on = entry->pump_on != 0;
}

static esp_err_t storage_sync_header_locked(void)
{
    if (!s_file) {
        return ESP_ERR_INVALID_STATE;
    }
    if (fseek(s_file, 0, SEEK_SET) != 0) {
        ESP_LOGE(TAG, "fseek header failed: %d", errno);
        return ESP_FAIL;
    }
    size_t written = fwrite(&s_header, sizeof(s_header), 1, s_file);
    if (written != 1) {
        ESP_LOGE(TAG, "header write failed: %d", errno);
        return ESP_FAIL;
    }
    fflush(s_file);
    return ESP_OK;
}

static esp_err_t storage_reset_locked(void)
{
    if (!s_file) {
        return ESP_ERR_INVALID_STATE;
    }
    ESP_LOGI(TAG, "Resetting ring buffer file");
    memset(&s_header, 0, sizeof(s_header));
    s_header.magic = STORAGE_MAGIC;
    s_header.version = STORAGE_VERSION;
    s_header.capacity = storage_get_capacity_config();
    s_header.head = 0;
    s_header.tail = 0;
    s_header.count = 0;

    if (fseek(s_file, 0, SEEK_SET) != 0) {
        ESP_LOGE(TAG, "fseek reset failed: %d", errno);
        return ESP_FAIL;
    }
    size_t written = fwrite(&s_header, sizeof(s_header), 1, s_file);
    if (written != 1) {
        ESP_LOGE(TAG, "write reset header failed: %d", errno);
        return ESP_FAIL;
    }
    fflush(s_file);
    return ESP_OK;
}

static esp_err_t storage_mount(void)
{
    esp_vfs_littlefs_conf_t conf = {
        .base_path = STORAGE_BASE_PATH,
        .partition_label = "storage",
        .format_if_mount_failed = true,
    };
    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "LittleFS mount failed: %s", esp_err_to_name(err));
        return err;
    }
    if (err == ESP_ERR_INVALID_STATE) {
        // Already mounted; continue.
        return ESP_OK;
    }
    ESP_LOGI(TAG, "LittleFS mounted on %s", STORAGE_BASE_PATH);
    size_t total = 0;
    size_t used = 0;
    if (esp_littlefs_info(conf.partition_label, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "LittleFS partition size=%u bytes used=%u bytes", (unsigned)total, (unsigned)used);
    }
    return ESP_OK;
}

esp_err_t storage_init(void)
{
    if (!s_lock) {
        s_lock = xSemaphoreCreateMutex();
        if (!s_lock) {
            ESP_LOGE(TAG, "Failed to create storage mutex");
            return ESP_ERR_NO_MEM;
        }
    }

    esp_err_t err = storage_mount();
    if (err != ESP_OK) {
        return err;
    }

    if (s_file) {
        s_ready = true;
        return ESP_OK;
    }

    s_file = fopen(STORAGE_FILE_PATH, "r+b");
    if (!s_file) {
        ESP_LOGW(TAG, "Creating new buffer file at %s", STORAGE_FILE_PATH);
        s_file = fopen(STORAGE_FILE_PATH, "w+b");
        if (!s_file) {
            ESP_LOGE(TAG, "Failed to open storage file: %d", errno);
            return ESP_FAIL;
        }
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    size_t read = fread(&s_header, sizeof(s_header), 1, s_file);
    if (read != 1 || s_header.magic != STORAGE_MAGIC || s_header.version != STORAGE_VERSION ||
        s_header.capacity != storage_get_capacity_config()) {
        ESP_LOGW(TAG, "Ring buffer header invalid; reinitializing");
        err = storage_reset_locked();
    } else {
        err = ESP_OK;
    }
    xSemaphoreGive(s_lock);

    if (err == ESP_OK) {
        s_ready = true;
    }
    return err;
}

size_t storage_capacity(void)
{
    return s_header.capacity;
}

size_t storage_count(void)
{
    if (!s_ready) {
        return 0;
    }
    size_t count = 0;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    count = s_header.count;
    xSemaphoreGive(s_lock);
    return count;
}

esp_err_t storage_append_sample(const telemetry_sample_t *sample)
{
    if (!s_ready || !sample) {
        return ESP_ERR_INVALID_STATE;
    }
    storage_entry_t entry = {0};
    storage_entry_from_sample(&entry, sample);

    xSemaphoreTake(s_lock, portMAX_DELAY);
    uint32_t capacity = s_header.capacity;
    if (capacity == 0) {
        xSemaphoreGive(s_lock);
        return ESP_FAIL;
    }
    uint32_t index = s_header.head;
    if (fseek(s_file, (long)entry_offset(index), SEEK_SET) != 0) {
        ESP_LOGE(TAG, "fseek append failed: %d", errno);
        xSemaphoreGive(s_lock);
        return ESP_FAIL;
    }
    size_t written = fwrite(&entry, sizeof(entry), 1, s_file);
    if (written != 1) {
        ESP_LOGE(TAG, "write append failed: %d", errno);
        xSemaphoreGive(s_lock);
        return ESP_FAIL;
    }
    fflush(s_file);

    if (s_header.count == capacity) {
        // overwrite oldest -> advance tail
        s_header.tail = (s_header.tail + 1) % capacity;
    } else {
        s_header.count++;
    }
    s_header.head = (s_header.head + 1) % capacity;
    esp_err_t err = storage_sync_header_locked();
    xSemaphoreGive(s_lock);
    return err;
}

bool storage_peek_oldest(telemetry_sample_t *out)
{
    if (!s_ready || !out) {
        return false;
    }
    bool ok = false;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_header.count == 0) {
        ok = false;
    } else {
        uint32_t index = s_header.tail;
        if (fseek(s_file, (long)entry_offset(index), SEEK_SET) != 0) {
            ESP_LOGE(TAG, "fseek peek failed: %d", errno);
        } else {
            storage_entry_t entry = {0};
            size_t read = fread(&entry, sizeof(entry), 1, s_file);
            if (read == 1) {
                storage_entry_to_sample(&entry, out);
                ok = true;
            } else {
                ESP_LOGE(TAG, "read peek failed: %d", errno);
            }
        }
    }
    xSemaphoreGive(s_lock);
    return ok;
}

esp_err_t storage_drop_oldest(void)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_header.count == 0) {
        xSemaphoreGive(s_lock);
        return ESP_ERR_INVALID_SIZE;
    }
    uint32_t capacity = s_header.capacity;
    s_header.tail = (s_header.tail + 1) % capacity;
    if (s_header.count > 0) {
        s_header.count--;
    }
    esp_err_t err = storage_sync_header_locked();
    xSemaphoreGive(s_lock);
    return err;
}

