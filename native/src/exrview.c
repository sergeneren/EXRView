#include "exrview.h"

#include <openexr.h>

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct exrv_file
{
    exr_context_t ctxt;
    uint8_t*      data;
    size_t        size;
    char*         header_json;
};

static char g_last_error[512];

static void
set_error (const char* fmt, ...)
{
    va_list ap;
    va_start (ap, fmt);
    vsnprintf (g_last_error, sizeof (g_last_error), fmt, ap);
    va_end (ap);
}

const char*
exrv_last_error (void)
{
    return g_last_error;
}

static void
error_handler (exr_const_context_t ctxt, exr_result_t code, const char* msg)
{
    (void) ctxt;
    set_error ("%s (%s)", msg ? msg : "", exr_get_default_error_message (code));
}

static int64_t
mem_read (
    exr_const_context_t         ctxt,
    void*                       userdata,
    void*                       buffer,
    uint64_t                    sz,
    uint64_t                    offset,
    exr_stream_error_func_ptr_t error_cb)
{
    exrv_file* f = (exrv_file*) userdata;
    if (offset >= f->size)
    {
        if (error_cb) error_cb (ctxt, EXR_ERR_READ_IO, "read past end of file");
        return -1;
    }
    uint64_t avail = f->size - offset;
    if (sz > avail) sz = avail;
    memcpy (buffer, f->data + offset, (size_t) sz);
    return (int64_t) sz;
}

static int64_t
mem_size (exr_const_context_t ctxt, void* userdata)
{
    (void) ctxt;
    return (int64_t) ((exrv_file*) userdata)->size;
}

exrv_file*
exrv_open (uint8_t* data, size_t size)
{
    g_last_error[0] = '\0';

    exrv_file* f = (exrv_file*) calloc (1, sizeof (exrv_file));
    if (!f)
    {
        free (data);
        set_error ("out of memory");
        return NULL;
    }
    f->data = data;
    f->size = size;

    exr_context_initializer_t init = EXR_DEFAULT_CONTEXT_INITIALIZER;
    init.error_handler_fn          = error_handler;
    init.user_data                 = f;
    init.read_fn                   = mem_read;
    init.size_fn                   = mem_size;

    exr_result_t rv = exr_start_read (&f->ctxt, "memory", &init);
    if (rv != EXR_ERR_SUCCESS)
    {
        if (!g_last_error[0])
            set_error ("%s", exr_get_default_error_message (rv));
        exrv_close (f);
        return NULL;
    }
    return f;
}

void
exrv_close (exrv_file* f)
{
    if (!f) return;
    if (f->ctxt) exr_finish (&f->ctxt);
    free (f->header_json);
    free (f->data);
    free (f);
}

/* ------------------------------------------------------------------------ */
/* JSON header                                                              */

typedef struct
{
    char*  buf;
    size_t len;
    size_t cap;
    int    oom;
} sbuf;

static void
sb_reserve (sbuf* sb, size_t extra)
{
    if (sb->oom || sb->len + extra + 1 <= sb->cap) return;
    size_t ncap = sb->cap ? sb->cap : 4096;
    while (ncap < sb->len + extra + 1)
        ncap *= 2;
    char* nb = (char*) realloc (sb->buf, ncap);
    if (!nb)
    {
        sb->oom = 1;
        return;
    }
    sb->buf = nb;
    sb->cap = ncap;
}

static void
sb_puts (sbuf* sb, const char* s)
{
    size_t n = strlen (s);
    sb_reserve (sb, n);
    if (sb->oom) return;
    memcpy (sb->buf + sb->len, s, n + 1);
    sb->len += n;
}

static void
sb_printf (sbuf* sb, const char* fmt, ...)
{
    char    tmp[256];
    va_list ap;
    va_start (ap, fmt);
    int n = vsnprintf (tmp, sizeof (tmp), fmt, ap);
    va_end (ap);
    if (n < 0) return;
    if ((size_t) n < sizeof (tmp))
    {
        sb_puts (sb, tmp);
        return;
    }
    sb_reserve (sb, (size_t) n);
    if (sb->oom) return;
    va_start (ap, fmt);
    vsnprintf (sb->buf + sb->len, (size_t) n + 1, fmt, ap);
    va_end (ap);
    sb->len += (size_t) n;
}

static void
sb_json_str (sbuf* sb, const char* s, int len)
{
    sb_puts (sb, "\"");
    for (int i = 0; s && (len < 0 ? s[i] != '\0' : i < len); ++i)
    {
        unsigned char c = (unsigned char) s[i];
        switch (c)
        {
            case '"': sb_puts (sb, "\\\""); break;
            case '\\': sb_puts (sb, "\\\\"); break;
            case '\n': sb_puts (sb, "\\n"); break;
            case '\r': sb_puts (sb, "\\r"); break;
            case '\t': sb_puts (sb, "\\t"); break;
            default:
                if (c < 0x20)
                    sb_printf (sb, "\\u%04x", c);
                else
                {
                    char ch[2] = {(char) c, '\0'};
                    sb_puts (sb, ch);
                }
        }
    }
    sb_puts (sb, "\"");
}

/* JSON has no NaN/Inf, so those become strings. */
static void
sb_num (sbuf* sb, double v, int is_double)
{
    if (isnan (v))
        sb_puts (sb, "\"NaN\"");
    else if (isinf (v))
        sb_puts (sb, v > 0 ? "\"Infinity\"" : "\"-Infinity\"");
    else
        sb_printf (sb, is_double ? "%.17g" : "%.9g", v);
}

static void
sb_num_array (sbuf* sb, const void* arr, int n, int is_double)
{
    sb_puts (sb, "[");
    for (int i = 0; i < n; ++i)
    {
        if (i) sb_puts (sb, ",");
        sb_num (
            sb,
            is_double ? ((const double*) arr)[i] : ((const float*) arr)[i],
            is_double);
    }
    sb_puts (sb, "]");
}

static const char*
compression_name (int c)
{
    static const char* names[] = {
        "none", "rle",  "zips", "zip",  "piz",      "pxr24",
        "b44",  "b44a", "dwaa", "dwab", "htj2k256", "htj2k32",
        "lj2k", "zstd"};
    if (c >= 0 && c < (int) (sizeof (names) / sizeof (names[0])))
        return names[c];
    return "unknown";
}

static const char*
storage_name (exr_storage_t s)
{
    switch (s)
    {
        case EXR_STORAGE_SCANLINE: return "scanline";
        case EXR_STORAGE_TILED: return "tiled";
        case EXR_STORAGE_DEEP_SCANLINE: return "deepscanline";
        case EXR_STORAGE_DEEP_TILED: return "deeptiled";
        default: return "unknown";
    }
}

static const char*
pixel_type_name (exr_pixel_type_t t)
{
    switch (t)
    {
        case EXR_PIXEL_UINT: return "uint";
        case EXR_PIXEL_HALF: return "half";
        case EXR_PIXEL_FLOAT: return "float";
        default: return "unknown";
    }
}

static void
sb_box2i (sbuf* sb, const exr_attr_box2i_t* b)
{
    sb_printf (
        sb,
        "{\"min\":[%d,%d],\"max\":[%d,%d]}",
        b->min.x,
        b->min.y,
        b->max.x,
        b->max.y);
}

static void
sb_attr_value (sbuf* sb, const exr_attribute_t* a)
{
    switch (a->type)
    {
        case EXR_ATTR_BOX2I: sb_box2i (sb, a->box2i); break;
        case EXR_ATTR_BOX2F:
            sb_puts (sb, "{\"min\":");
            sb_num_array (sb, &a->box2f->min, 2, 0);
            sb_puts (sb, ",\"max\":");
            sb_num_array (sb, &a->box2f->max, 2, 0);
            sb_puts (sb, "}");
            break;
        case EXR_ATTR_CHLIST: sb_printf (sb, "%d", a->chlist->num_channels); break;
        case EXR_ATTR_CHROMATICITIES:
            sb_num_array (sb, a->chromaticities, 8, 0);
            break;
        case EXR_ATTR_COMPRESSION:
            sb_json_str (sb, compression_name (a->uc), -1);
            break;
        case EXR_ATTR_DOUBLE: sb_num (sb, a->d, 1); break;
        case EXR_ATTR_FLOAT: sb_num (sb, a->f, 0); break;
        case EXR_ATTR_INT: sb_printf (sb, "%d", a->i); break;
        case EXR_ATTR_ENVMAP:
            sb_json_str (sb, a->uc == 0 ? "latlong" : "cube", -1);
            break;
        case EXR_ATTR_LINEORDER: {
            static const char* lo[] = {"increasing_y", "decreasing_y", "random_y"};
            sb_json_str (sb, a->uc < 3 ? lo[a->uc] : "unknown", -1);
            break;
        }
        case EXR_ATTR_DEEP_IMAGE_STATE: sb_printf (sb, "%d", a->uc); break;
        case EXR_ATTR_FLOAT_VECTOR:
            sb_num_array (sb, a->floatvector->arr, a->floatvector->length, 0);
            break;
        case EXR_ATTR_KEYCODE:
            sb_printf (
                sb,
                "{\"filmMfcCode\":%d,\"filmType\":%d,\"prefix\":%d,\"count\":%d,"
                "\"perfOffset\":%d,\"perfsPerFrame\":%d,\"perfsPerCount\":%d}",
                a->keycode->film_mfc_code,
                a->keycode->film_type,
                a->keycode->prefix,
                a->keycode->count,
                a->keycode->perf_offset,
                a->keycode->perfs_per_frame,
                a->keycode->perfs_per_count);
            break;
        case EXR_ATTR_M33F: sb_num_array (sb, a->m33f->m, 9, 0); break;
        case EXR_ATTR_M33D: sb_num_array (sb, a->m33d->m, 9, 1); break;
        case EXR_ATTR_M44F: sb_num_array (sb, a->m44f->m, 16, 0); break;
        case EXR_ATTR_M44D: sb_num_array (sb, a->m44d->m, 16, 1); break;
        case EXR_ATTR_PREVIEW:
            sb_printf (
                sb,
                "{\"width\":%u,\"height\":%u}",
                a->preview->width,
                a->preview->height);
            break;
        case EXR_ATTR_RATIONAL:
            sb_printf (sb, "[%d,%u]", a->rational->num, a->rational->denom);
            break;
        case EXR_ATTR_STRING:
            sb_json_str (sb, a->string->str, a->string->length);
            break;
        case EXR_ATTR_STRING_VECTOR:
            sb_puts (sb, "[");
            for (int i = 0; i < a->stringvector->n_strings; ++i)
            {
                if (i) sb_puts (sb, ",");
                sb_json_str (
                    sb,
                    a->stringvector->strings[i].str,
                    a->stringvector->strings[i].length);
            }
            sb_puts (sb, "]");
            break;
        case EXR_ATTR_TILEDESC:
            sb_printf (
                sb,
                "{\"xSize\":%u,\"ySize\":%u,\"levelMode\":%d,\"roundMode\":%d}",
                a->tiledesc->x_size,
                a->tiledesc->y_size,
                (int) EXR_GET_TILE_LEVEL_MODE (*a->tiledesc),
                (int) EXR_GET_TILE_ROUND_MODE (*a->tiledesc));
            break;
        case EXR_ATTR_TIMECODE:
            sb_printf (
                sb,
                "{\"timeAndFlags\":%u,\"userData\":%u}",
                a->timecode->time_and_flags,
                a->timecode->user_data);
            break;
        case EXR_ATTR_V2I:
            sb_printf (sb, "[%d,%d]", a->v2i->x, a->v2i->y);
            break;
        case EXR_ATTR_V2F: sb_num_array (sb, a->v2f, 2, 0); break;
        case EXR_ATTR_V2D: sb_num_array (sb, a->v2d, 2, 1); break;
        case EXR_ATTR_V3I:
            sb_printf (sb, "[%d,%d,%d]", a->v3i->x, a->v3i->y, a->v3i->z);
            break;
        case EXR_ATTR_V3F: sb_num_array (sb, a->v3f, 3, 0); break;
        case EXR_ATTR_V3D: sb_num_array (sb, a->v3d, 3, 1); break;
        case EXR_ATTR_BYTES:
            sb_printf (sb, "{\"size\":%zu}", a->bytes->size);
            break;
        case EXR_ATTR_OPAQUE:
            sb_printf (sb, "{\"size\":%d}", a->opaque->size);
            break;
        default: sb_puts (sb, "null"); break;
    }
}

static exr_result_t
write_part_json (sbuf* sb, exr_const_context_t ctxt, int p)
{
    exr_result_t      rv;
    const char*       name = NULL;
    exr_storage_t     storage;
    exr_compression_t comp;
    exr_attr_box2i_t  dw, dispw;
    const exr_attr_chlist_t* chlist;

    exr_get_name (ctxt, p, &name); /* optional for single-part files */
    if ((rv = exr_get_storage (ctxt, p, &storage))) return rv;
    if ((rv = exr_get_compression (ctxt, p, &comp))) return rv;
    if ((rv = exr_get_data_window (ctxt, p, &dw))) return rv;
    if ((rv = exr_get_display_window (ctxt, p, &dispw))) return rv;
    if ((rv = exr_get_channels (ctxt, p, &chlist))) return rv;

    sb_printf (sb, "{\"index\":%d,\"name\":", p);
    if (name)
        sb_json_str (sb, name, -1);
    else
        sb_puts (sb, "null");
    sb_puts (sb, ",\"storage\":");
    sb_json_str (sb, storage_name (storage), -1);
    sb_puts (sb, ",\"compression\":");
    sb_json_str (sb, compression_name ((int) comp), -1);
    sb_puts (sb, ",\"dataWindow\":");
    sb_box2i (sb, &dw);
    sb_puts (sb, ",\"displayWindow\":");
    sb_box2i (sb, &dispw);

    if (storage == EXR_STORAGE_TILED || storage == EXR_STORAGE_DEEP_TILED)
    {
        int32_t lx = 0, ly = 0, tw = 0, th = 0;
        exr_get_tile_levels (ctxt, p, &lx, &ly);
        exr_get_tile_sizes (ctxt, p, 0, 0, &tw, &th);
        sb_printf (
            sb,
            ",\"tiles\":{\"width\":%d,\"height\":%d,\"levelsX\":%d,\"levelsY\":%d}",
            tw,
            th,
            lx,
            ly);
    }

    sb_puts (sb, ",\"channels\":[");
    for (int c = 0; c < chlist->num_channels; ++c)
    {
        const exr_attr_chlist_entry_t* e = &chlist->entries[c];
        if (c) sb_puts (sb, ",");
        sb_puts (sb, "{\"name\":");
        sb_json_str (sb, e->name.str, e->name.length);
        sb_puts (sb, ",\"type\":");
        sb_json_str (sb, pixel_type_name (e->pixel_type), -1);
        sb_printf (
            sb,
            ",\"xSampling\":%d,\"ySampling\":%d,\"pLinear\":%s}",
            e->x_sampling,
            e->y_sampling,
            e->p_linear ? "true" : "false");
    }
    sb_puts (sb, "]");

    int32_t nattr = 0;
    if ((rv = exr_get_attribute_count (ctxt, p, &nattr))) return rv;
    sb_puts (sb, ",\"attributes\":[");
    for (int32_t i = 0; i < nattr; ++i)
    {
        const exr_attribute_t* a = NULL;
        rv = exr_get_attribute_by_index (
            ctxt, p, EXR_ATTR_LIST_SORTED_ORDER, i, &a);
        if (rv) return rv;
        if (i) sb_puts (sb, ",");
        sb_puts (sb, "{\"name\":");
        sb_json_str (sb, a->name, a->name_length);
        sb_puts (sb, ",\"type\":");
        sb_json_str (sb, a->type_name, a->type_name_length);
        sb_puts (sb, ",\"value\":");
        sb_attr_value (sb, a);
        sb_puts (sb, "}");
    }
    sb_puts (sb, "]}");
    return EXR_ERR_SUCCESS;
}

const char*
exrv_header_json (exrv_file* f)
{
    if (!f) return NULL;
    if (f->header_json) return f->header_json;

    sbuf         sb = {0};
    int          nparts = 0;
    uint32_t     flags  = 0;
    int          maj = 0, min = 0, patch = 0;
    const char*  extra = NULL;
    exr_result_t rv    = exr_get_count (f->ctxt, &nparts);
    if (rv)
    {
        set_error ("%s", exr_get_default_error_message (rv));
        return NULL;
    }
    exr_get_file_version_and_flags (f->ctxt, &flags);
    exr_get_library_version (&maj, &min, &patch, &extra);

    sb_printf (
        &sb,
        "{\"library\":\"OpenEXR %d.%d.%d\",\"version\":%u,\"flags\":%u,\"parts\":[",
        maj,
        min,
        patch,
        flags & 0xff,
        flags >> 8);
    for (int p = 0; p < nparts; ++p)
    {
        if (p) sb_puts (&sb, ",");
        rv = write_part_json (&sb, f->ctxt, p);
        if (rv)
        {
            set_error ("part %d: %s", p, exr_get_default_error_message (rv));
            free (sb.buf);
            return NULL;
        }
    }
    sb_puts (&sb, "]}");

    if (sb.oom)
    {
        free (sb.buf);
        set_error ("out of memory");
        return NULL;
    }
    f->header_json = sb.buf;
    return f->header_json;
}

/* ------------------------------------------------------------------------ */
/* Pixel decoding                                                           */

/* Floor division, valid for negative numerators (data windows may start
 * at negative coordinates). */
static int
floor_div (int a, int b)
{
    int q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

/* Number of sample positions (multiples of s) in [lo, hi). */
static int
sample_count (int lo, int hi, int s)
{
    return floor_div (hi - 1, s) - floor_div (lo - 1, s);
}

/* Called once per chunk of level 0 with the chunk's pixel origin. */
typedef exr_result_t (*chunk_fn) (
    void* user, const exr_chunk_info_t* cinfo, int px, int py);

static exr_result_t
for_each_chunk (
    exr_const_context_t     ctxt,
    int                     part,
    exr_storage_t           storage,
    const exr_attr_box2i_t* dw,
    chunk_fn                fn,
    void*                   user)
{
    exr_result_t     rv = EXR_ERR_SUCCESS;
    exr_chunk_info_t cinfo;

    if (storage == EXR_STORAGE_SCANLINE ||
        storage == EXR_STORAGE_DEEP_SCANLINE)
    {
        for (int y = dw->min.y; y <= dw->max.y && rv == EXR_ERR_SUCCESS;
             y     = cinfo.start_y + cinfo.height)
        {
            rv = exr_read_scanline_chunk_info (ctxt, part, y, &cinfo);
            if (rv == EXR_ERR_SUCCESS)
                rv = fn (user, &cinfo, cinfo.start_x, cinfo.start_y);
        }
        return rv;
    }

    /* Tiled: chunk info carries tile indices, not pixel coordinates. */
    int32_t tw = 0, th = 0, tx = 0, ty = 0;
    if ((rv = exr_get_tile_sizes (ctxt, part, 0, 0, &tw, &th)) ||
        (rv = exr_get_tile_counts (ctxt, part, 0, 0, &tx, &ty)))
        return rv;
    for (int j = 0; j < ty && rv == EXR_ERR_SUCCESS; ++j)
    {
        for (int i = 0; i < tx && rv == EXR_ERR_SUCCESS; ++i)
        {
            rv = exr_read_tile_chunk_info (ctxt, part, i, j, 0, 0, &cinfo);
            if (rv == EXR_ERR_SUCCESS)
                rv = fn (user, &cinfo, dw->min.x + i * tw, dw->min.y + j * th);
        }
    }
    return rv;
}

static exr_result_t
start_chunk (
    exr_const_context_t     ctxt,
    int                     part,
    const exr_chunk_info_t* cinfo,
    exr_decode_pipeline_t*  dec,
    int*                    initialized)
{
    if (*initialized) return exr_decoding_update (ctxt, part, cinfo, dec);
    exr_result_t rv = exr_decoding_initialize (ctxt, part, cinfo, dec);
    if (rv == EXR_ERR_SUCCESS) *initialized = 1;
    return rv;
}

/* ---- flat images ---- */

typedef struct
{
    int    file_index; /* index into the part's channel list */
    int    xs, ys;
    int    sw, sh; /* sample-plane size */
    float* plane;  /* full-res output plane, or sample plane if subsampled */
} chan_target;

typedef struct
{
    exr_const_context_t     ctxt;
    int                     part;
    exr_decode_pipeline_t   dec;
    int                     initialized;
    chan_target*            targets;
    int                     ntargets;
    const exr_attr_box2i_t* dw;
} flat_state;

static exr_result_t
flat_chunk (void* user, const exr_chunk_info_t* cinfo, int px, int py)
{
    flat_state*  st = (flat_state*) user;
    exr_result_t rv =
        start_chunk (st->ctxt, st->part, cinfo, &st->dec, &st->initialized);
    if (rv) return rv;

    exr_decode_pipeline_t* dec = &st->dec;
    for (int c = 0; c < dec->channel_count; ++c)
        dec->channels[c].decode_to_ptr = NULL;

    for (int t = 0; t < st->ntargets; ++t)
    {
        chan_target*               tg = &st->targets[t];
        exr_coding_channel_info_t* ch = &dec->channels[tg->file_index];

        /* Chunk origin within the target's sample plane. */
        int sx = sample_count (st->dw->min.x, px, tg->xs);
        int sy = sample_count (st->dw->min.y, py, tg->ys);

        ch->user_data_type         = EXR_PIXEL_FLOAT;
        ch->user_bytes_per_element = 4;
        ch->user_pixel_stride      = 4;
        ch->user_line_stride       = 4 * tg->sw;
        ch->decode_to_ptr =
            (uint8_t*) (tg->plane + (size_t) sy * tg->sw + (size_t) sx);
    }

    if (!dec->unpack_and_convert_fn)
    {
        rv = exr_decoding_choose_default_routines (st->ctxt, st->part, dec);
        if (rv) return rv;
    }
    return exr_decoding_run (st->ctxt, st->part, dec);
}

static exr_result_t
decode_flat (
    exr_const_context_t      ctxt,
    int                      part,
    exr_storage_t            storage,
    const exr_attr_box2i_t*  dw,
    const exr_attr_chlist_t* chlist,
    const int32_t*           channel_indices,
    int                      channel_count,
    float*                   out)
{
    const int    width  = dw->max.x - dw->min.x + 1;
    const int    height = dw->max.y - dw->min.y + 1;
    const size_t npix   = (size_t) width * (size_t) height;
    exr_result_t rv     = EXR_ERR_SUCCESS;

    chan_target* targets =
        (chan_target*) calloc ((size_t) channel_count, sizeof (chan_target));
    if (!targets) return EXR_ERR_OUT_OF_MEMORY;

    for (int t = 0; t < channel_count; ++t)
    {
        int ci = channel_indices[t];
        if (ci < 0 || ci >= chlist->num_channels)
        {
            set_error ("channel index %d out of range", ci);
            rv = EXR_ERR_INVALID_ARGUMENT;
            goto done;
        }
        chan_target* tg = &targets[t];
        tg->file_index  = ci;
        tg->xs          = chlist->entries[ci].x_sampling;
        tg->ys          = chlist->entries[ci].y_sampling;
        tg->sw          = sample_count (dw->min.x, dw->max.x + 1, tg->xs);
        tg->sh          = sample_count (dw->min.y, dw->max.y + 1, tg->ys);
        if (tg->xs == 1 && tg->ys == 1)
            tg->plane = out + (size_t) t * npix;
        else
        {
            tg->plane =
                (float*) calloc ((size_t) tg->sw * tg->sh, sizeof (float));
            if (!tg->plane)
            {
                rv = EXR_ERR_OUT_OF_MEMORY;
                goto done;
            }
        }
    }

    {
        flat_state st = {0};
        st.ctxt       = ctxt;
        st.part       = part;
        st.dec        = (exr_decode_pipeline_t) EXR_DECODE_PIPELINE_INITIALIZER;
        st.targets    = targets;
        st.ntargets   = channel_count;
        st.dw         = dw;
        rv = for_each_chunk (ctxt, part, storage, dw, flat_chunk, &st);
        if (st.initialized) exr_decoding_destroy (ctxt, &st.dec);
        if (rv) goto done;
    }

    /* Expand subsampled channels to full resolution. */
    for (int t = 0; t < channel_count; ++t)
    {
        chan_target* tg = &targets[t];
        if (tg->xs == 1 && tg->ys == 1) continue;
        float* dst = out + (size_t) t * npix;
        for (int y = 0; y < height; ++y)
        {
            int sy = sample_count (dw->min.y, dw->min.y + y + 1, tg->ys) - 1;
            const float* srow = tg->plane + (size_t) (sy < 0 ? 0 : sy) * tg->sw;
            float*       drow = dst + (size_t) y * width;
            for (int x = 0; x < width; ++x)
            {
                int sx = sample_count (dw->min.x, dw->min.x + x + 1, tg->xs) - 1;
                drow[x] = srow[sx < 0 ? 0 : sx];
            }
        }
    }

done:
    for (int t = 0; t < channel_count; ++t)
        if (targets[t].plane && (targets[t].xs != 1 || targets[t].ys != 1))
            free (targets[t].plane);
    free (targets);
    return rv;
}

/* ---- deep images, flattened ---- */

typedef enum
{
    DEEP_OUT_COMPOSITE, /* premultiplied colour, composited "over" */
    DEEP_OUT_ALPHA,     /* 1 - prod(1 - a) */
    DEEP_OUT_FRONT,     /* frontmost sample (Z, ZBack, ids) */
    DEEP_OUT_COUNT      /* number of samples */
} deep_out_kind;

typedef struct
{
    deep_out_kind kind;
    int           src;   /* file channel index, -1 for COUNT */
    int           alpha; /* file channel index or -1 (COMPOSITE only) */
    float*        plane;
} deep_target;

typedef struct
{
    exr_const_context_t     ctxt;
    int                     part;
    exr_decode_pipeline_t   dec;
    int                     initialized;
    const exr_attr_box2i_t* dw;
    int                     width; /* data window */

    int      nfile;
    uint8_t* need;     /* per file channel: decode it */
    float**  samples;  /* per file channel: this chunk's samples */
    size_t*  capacity; /* per file channel, in floats */
    int      zc, zbc;  /* Z / ZBack file channel, or -1 */

    deep_target* targets;
    int          ntargets;

    float* trans; /* per target transmittance scratch */
    int*   order; /* per pixel sample order scratch */
    size_t order_cap;
} deep_state;

/* Returns the index of the channel called `layer` + `base`, or -1. */
static int
find_channel (
    const exr_attr_chlist_t* chlist, const char* layer, int llen, const char* base)
{
    size_t blen = strlen (base);
    for (int c = 0; c < chlist->num_channels; ++c)
    {
        const exr_attr_string_t* n = &chlist->entries[c].name;
        if ((size_t) n->length == (size_t) llen + blen &&
            !strncmp (n->str, layer, (size_t) llen) &&
            !strncmp (n->str + llen, base, blen))
            return c;
    }
    return -1;
}

static int
is_alpha_name (const char* base)
{
    return !strcmp (base, "A") || !strcmp (base, "RA") || !strcmp (base, "GA") ||
           !strcmp (base, "BA") || !strcmp (base, "AR") || !strcmp (base, "AG") ||
           !strcmp (base, "AB");
}

static void
classify_deep_target (
    const exr_attr_chlist_t* chlist, int ci, deep_target* tg)
{
    const exr_attr_chlist_entry_t* e = &chlist->entries[ci];

    /* Split "layer.base" at the last dot; layer keeps the dot. */
    const char* name = e->name.str;
    const char* dot  = strrchr (name, '.');
    int         llen = dot ? (int) (dot - name + 1) : 0;
    const char* base = name + llen;

    tg->src   = ci;
    tg->alpha = -1;

    if (e->pixel_type == EXR_PIXEL_UINT || !strcmp (base, "Z") ||
        !strcmp (base, "ZBack"))
    {
        tg->kind = DEEP_OUT_FRONT;
        return;
    }
    if (is_alpha_name (base))
    {
        tg->kind = DEEP_OUT_ALPHA;
        return;
    }

    /* Per-colour alpha (RA or AR style), then the layer's A, then A. */
    if (!strcmp (base, "R") || !strcmp (base, "G") || !strcmp (base, "B"))
    {
        char xa[3] = {base[0], 'A', '\0'};
        char ax[3] = {'A', base[0], '\0'};
        tg->alpha  = find_channel (chlist, name, llen, xa);
        if (tg->alpha < 0) tg->alpha = find_channel (chlist, name, llen, ax);
    }
    if (tg->alpha < 0) tg->alpha = find_channel (chlist, name, llen, "A");
    if (tg->alpha < 0) tg->alpha = find_channel (chlist, "", 0, "A");
    tg->kind = tg->alpha < 0 ? DEEP_OUT_FRONT : DEEP_OUT_COMPOSITE;
}

static exr_result_t
deep_realloc (exr_decode_pipeline_t* dec)
{
    deep_state* st    = (deep_state*) dec->decoding_user_data;
    size_t      total = 0;
    size_t      n     = (size_t) dec->chunk.width * (size_t) dec->chunk.height;
    for (size_t i = 0; i < n; ++i)
        total += (size_t) dec->sample_count_table[i];

    for (int c = 0; c < dec->channel_count; ++c)
    {
        exr_coding_channel_info_t* ch = &dec->channels[c];
        ch->user_data_type            = EXR_PIXEL_FLOAT;
        ch->user_bytes_per_element    = 4;
        ch->user_pixel_stride         = 4;
        ch->user_line_stride          = 0;
        ch->decode_to_ptr             = NULL;
        if (!st->need[c] || total == 0) continue;

        if (st->capacity[c] < total)
        {
            float* nb = (float*) realloc (st->samples[c], total * sizeof (float));
            if (!nb) return EXR_ERR_OUT_OF_MEMORY;
            st->samples[c]  = nb;
            st->capacity[c] = total;
        }
        ch->decode_to_ptr = (uint8_t*) st->samples[c];
    }
    return EXR_ERR_SUCCESS;
}

/* Sorts sample indices front to back by Z, then ZBack (shell sort; deep
 * pixels are usually small but can hold thousands of samples). */
static void
sort_samples (int* idx, int n, const float* z, const float* zb)
{
    static const int gaps[] = {701, 301, 132, 57, 23, 10, 4, 1};
    for (size_t g = 0; g < sizeof (gaps) / sizeof (gaps[0]); ++g)
    {
        int gap = gaps[g];
        for (int i = gap; i < n; ++i)
        {
            int v = idx[i];
            int j = i;
            for (; j >= gap; j -= gap)
            {
                int   u  = idx[j - gap];
                float zu = z[u], zv = z[v];
                if (zu < zv || (zu == zv && (!zb || zb[u] <= zb[v]))) break;
                idx[j] = u;
            }
            idx[j] = v;
        }
    }
}

static exr_result_t
deep_chunk (void* user, const exr_chunk_info_t* cinfo, int px, int py)
{
    deep_state*  st = (deep_state*) user;
    exr_result_t rv =
        start_chunk (st->ctxt, st->part, cinfo, &st->dec, &st->initialized);
    if (rv) return rv;

    exr_decode_pipeline_t* dec = &st->dec;
    dec->decode_flags |= EXR_DECODE_SAMPLE_COUNTS_AS_INDIVIDUAL;
    dec->decoding_user_data       = st;
    dec->realloc_nonimage_data_fn = deep_realloc;
    if (!dec->unpack_and_convert_fn)
    {
        for (int c = 0; c < dec->channel_count; ++c)
        {
            dec->channels[c].user_data_type         = EXR_PIXEL_FLOAT;
            dec->channels[c].user_bytes_per_element = 4;
        }
        rv = exr_decoding_choose_default_routines (st->ctxt, st->part, dec);
        if (rv) return rv;
    }
    rv = exr_decoding_run (st->ctxt, st->part, dec);
    if (rv) return rv;

    const int32_t* counts = dec->sample_count_table;
    const float*   z      = st->zc >= 0 ? st->samples[st->zc] : NULL;
    const float*   zb     = st->zbc >= 0 ? st->samples[st->zbc] : NULL;
    size_t         base   = 0;

    for (int y = 0; y < cinfo->height; ++y)
    {
        size_t row = (size_t) (py - st->dw->min.y + y) * (size_t) st->width;
        for (int x = 0; x < cinfo->width; ++x)
        {
            int    n   = counts[(size_t) y * cinfo->width + x];
            size_t pix = row + (size_t) (px - st->dw->min.x + x);

            if ((size_t) n > st->order_cap)
            {
                int* no = (int*) realloc (st->order, (size_t) n * sizeof (int));
                if (!no) return EXR_ERR_OUT_OF_MEMORY;
                st->order     = no;
                st->order_cap = (size_t) n;
            }
            for (int s = 0; s < n; ++s)
                st->order[s] = (int) base + s;
            if (z && n > 1) sort_samples (st->order, n, z, zb);

            for (int t = 0; t < st->ntargets; ++t)
            {
                deep_target* tg  = &st->targets[t];
                const float* v   = tg->src >= 0 ? st->samples[tg->src] : NULL;
                float        acc = 0.f;
                switch (tg->kind)
                {
                    case DEEP_OUT_COUNT: acc = (float) n; break;
                    case DEEP_OUT_FRONT:
                        acc = n > 0 ? v[st->order[0]] : 0.f;
                        break;
                    case DEEP_OUT_ALPHA: {
                        float tr = 1.f;
                        for (int s = 0; s < n; ++s)
                            tr *= 1.f - v[st->order[s]];
                        acc = 1.f - tr;
                        break;
                    }
                    case DEEP_OUT_COMPOSITE: {
                        const float* a  = st->samples[tg->alpha];
                        float        tr = 1.f;
                        for (int s = 0; s < n && tr > 0.f; ++s)
                        {
                            int i = st->order[s];
                            acc += tr * v[i];
                            tr *= 1.f - a[i];
                        }
                        break;
                    }
                }
                tg->plane[pix] = acc;
            }
            base += (size_t) n;
        }
    }
    return EXR_ERR_SUCCESS;
}

static exr_result_t
decode_deep (
    exr_const_context_t      ctxt,
    int                      part,
    exr_storage_t            storage,
    const exr_attr_box2i_t*  dw,
    const exr_attr_chlist_t* chlist,
    const int32_t*           channel_indices,
    int                      channel_count,
    float*                   out)
{
    const size_t npix = (size_t) (dw->max.x - dw->min.x + 1) *
                        (size_t) (dw->max.y - dw->min.y + 1);
    const int    nfile = chlist->num_channels;
    exr_result_t rv    = EXR_ERR_SUCCESS;

    deep_state st = {0};
    st.ctxt       = ctxt;
    st.part       = part;
    st.dec        = (exr_decode_pipeline_t) EXR_DECODE_PIPELINE_INITIALIZER;
    st.dw         = dw;
    st.width      = dw->max.x - dw->min.x + 1;
    st.nfile      = nfile;
    st.need       = (uint8_t*) calloc ((size_t) nfile, 1);
    st.samples    = (float**) calloc ((size_t) nfile, sizeof (float*));
    st.capacity   = (size_t*) calloc ((size_t) nfile, sizeof (size_t));
    st.targets =
        (deep_target*) calloc ((size_t) channel_count, sizeof (deep_target));
    st.ntargets = channel_count;
    if (!st.need || !st.samples || !st.capacity || !st.targets)
    {
        rv = EXR_ERR_OUT_OF_MEMORY;
        goto done;
    }

    st.zc  = find_channel (chlist, "", 0, "Z");
    st.zbc = find_channel (chlist, "", 0, "ZBack");
    if (st.zc >= 0) st.need[st.zc] = 1;
    if (st.zbc >= 0) st.need[st.zbc] = 1;

    for (int t = 0; t < channel_count; ++t)
    {
        int          ci = channel_indices[t];
        deep_target* tg = &st.targets[t];
        tg->plane       = out + (size_t) t * npix;
        if (ci == EXRV_SAMPLE_COUNT_CHANNEL)
        {
            tg->kind = DEEP_OUT_COUNT;
            tg->src  = -1;
            continue;
        }
        if (ci < 0 || ci >= nfile)
        {
            set_error ("channel index %d out of range", ci);
            rv = EXR_ERR_INVALID_ARGUMENT;
            goto done;
        }
        classify_deep_target (chlist, ci, tg);
        st.need[tg->src] = 1;
        if (tg->alpha >= 0) st.need[tg->alpha] = 1;
    }

    rv = for_each_chunk (ctxt, part, storage, dw, deep_chunk, &st);
    if (st.initialized) exr_decoding_destroy (ctxt, &st.dec);

done:
    if (st.samples)
        for (int c = 0; c < nfile; ++c)
            free (st.samples[c]);
    free (st.samples);
    free (st.capacity);
    free (st.need);
    free (st.targets);
    free (st.order);
    return rv;
}

int
exrv_decode_channels (
    exrv_file*     f,
    int            part,
    const int32_t* channel_indices,
    int            channel_count,
    float*         out)
{
    g_last_error[0] = '\0';
    if (!f || !out || !channel_indices || channel_count <= 0)
    {
        set_error ("invalid arguments");
        return EXR_ERR_INVALID_ARGUMENT;
    }

    exr_storage_t            storage;
    exr_attr_box2i_t         dw;
    const exr_attr_chlist_t* chlist;
    exr_result_t             rv;

    if ((rv = exr_get_storage (f->ctxt, part, &storage)) ||
        (rv = exr_get_data_window (f->ctxt, part, &dw)) ||
        (rv = exr_get_channels (f->ctxt, part, &chlist)))
    {
        set_error ("%s", exr_get_default_error_message (rv));
        return rv;
    }

    if (storage == EXR_STORAGE_DEEP_SCANLINE ||
        storage == EXR_STORAGE_DEEP_TILED)
        rv = decode_deep (
            f->ctxt, part, storage, &dw, chlist, channel_indices, channel_count, out);
    else
        rv = decode_flat (
            f->ctxt, part, storage, &dw, chlist, channel_indices, channel_count, out);

    if (rv != EXR_ERR_SUCCESS && !g_last_error[0])
        set_error ("%s", exr_get_default_error_message (rv));
    return rv;
}
