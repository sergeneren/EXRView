/*
 * EXRView decoder: a thin C layer over OpenEXRCore, shared by the wasm build
 * (loaded in the VS Code webview) and the native test tool.
 */
#ifndef EXRVIEW_H
#define EXRVIEW_H

#include <stddef.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#    include <emscripten/emscripten.h>
#    define EXRV_API EMSCRIPTEN_KEEPALIVE
#else
#    define EXRV_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct exrv_file exrv_file;

/* Opens an EXR held in memory. Takes ownership of `data`, which must have
 * been allocated with malloc; it is freed by exrv_close (or on failure).
 * Returns NULL on failure; see exrv_last_error. */
EXRV_API exrv_file* exrv_open (uint8_t* data, size_t size);

EXRV_API void exrv_close (exrv_file* f);

/* Message for the most recent failure on this thread. */
EXRV_API const char* exrv_last_error (void);

/* JSON description of every part: storage, compression, windows, channels
 * and all attributes. Owned by `f`, valid until exrv_close. */
EXRV_API const char* exrv_header_json (exrv_file* f);

/* Pseudo channel index for deep parts: per-pixel sample count. */
#define EXRV_SAMPLE_COUNT_CHANNEL (-1)

/* Decodes the given channels (indices into the part's channel list) of
 * level 0 of `part` into `out` as planar float32: channel_count planes of
 * data-window width * height each, rows top to bottom. Subsampled channels
 * are upsampled by replication.
 *
 * Deep parts are flattened: samples are sorted front to back by Z (then
 * ZBack) and composited "over" using each channel's alpha (RA/AR style
 * per-colour alpha, else the layer's A, else A). Alpha channels give the
 * accumulated coverage; Z, ZBack and uint channels give the frontmost
 * sample. Returns 0 on success. */
EXRV_API int exrv_decode_channels (
    exrv_file*     f,
    int            part,
    const int32_t* channel_indices,
    int            channel_count,
    float*         out);

#ifdef __cplusplus
}
#endif

#endif /* EXRVIEW_H */
