#pragma once

#include "esp_err.h"

esp_err_t put_char(const char *key, unsigned char value);
char get_char(const char *key, unsigned char default_value);
