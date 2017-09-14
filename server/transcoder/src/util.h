#ifndef __BUM_UTIL_H__
#define __BUM_UTIL_H__

#include <stdio.h>

#ifdef INSECURE
int pledge(const char* promises, const char* paths[]) {
    errno = ENOSYS;
    return 1;
}
#endif

static inline void __warn(const char* file, int line, const char* func, const char* text) {
    fprintf(stderr, "Assertion failed: %s:%d (%s): %s\n", file, line, func, text);
    if (errno != 0) {
        perror("    error ");
    }

    errno = 0;
}

static inline void __fail(const char* file, int line, const char* func, const char* text) {
    __warn(file, line, func, text);
    exit(1);
}

#define verify(cond) ((cond)? (0) : __fail(__FILE__, __LINE__, __func__, #cond))
#define verify_ffmpeg(status) ((status) == 0? (0) : __fail(__FILE__, __LINE__, __func__, av_err2str(status)))
#define verify_warn(cond) ((cond)? (0) : __warn(__FILE__, __LINE__, __func__, #cond))

static inline int min(int a, int b) {
    return (a < b) ? a : b;
}

#endif
