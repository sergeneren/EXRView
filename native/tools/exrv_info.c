/*
 * Native test driver for the EXRView decoder: prints the header JSON and
 * per-channel statistics for every part.
 *
 *   exrv_info [--header-only] file.exr
 */
#include "exrview.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static uint8_t*
read_file (const char* path, size_t* size)
{
    FILE* fp = fopen (path, "rb");
    if (!fp) return NULL;
    fseek (fp, 0, SEEK_END);
    long n = ftell (fp);
    fseek (fp, 0, SEEK_SET);
    uint8_t* buf = (uint8_t*) malloc (n > 0 ? (size_t) n : 1);
    if (buf && fread (buf, 1, (size_t) n, fp) != (size_t) n)
    {
        free (buf);
        buf = NULL;
    }
    fclose (fp);
    *size = (size_t) n;
    return buf;
}

/* Minimal scan of the header JSON for each part's data window and channel
 * names; the real consumer is the TypeScript side. */
static const char*
find_after (const char* s, const char* key)
{
    const char* p = strstr (s, key);
    return p ? p + strlen (key) : NULL;
}

int
main (int argc, char** argv)
{
    int         header_only = 0;
    const char* path        = NULL;
    for (int i = 1; i < argc; ++i)
    {
        if (!strcmp (argv[i], "--header-only"))
            header_only = 1;
        else
            path = argv[i];
    }
    if (!path)
    {
        fprintf (stderr, "usage: exrv_info [--header-only] file.exr\n");
        return 2;
    }

    size_t   size = 0;
    uint8_t* data = read_file (path, &size);
    if (!data)
    {
        fprintf (stderr, "cannot read %s\n", path);
        return 1;
    }

    exrv_file* f = exrv_open (data, size);
    if (!f)
    {
        fprintf (stderr, "open failed: %s\n", exrv_last_error ());
        return 1;
    }

    const char* json = exrv_header_json (f);
    if (!json)
    {
        fprintf (stderr, "header failed: %s\n", exrv_last_error ());
        exrv_close (f);
        return 1;
    }
    printf ("%s\n", json);
    if (header_only)
    {
        exrv_close (f);
        return 0;
    }

    int         status = 0;
    const char* p      = find_after (json, "\"parts\":[");
    for (int part = 0; p && (p = find_after (p, "\"storage\":\"")); ++part)
    {
        int deep = !strncmp (p, "deep", 4);
        if (!(p = find_after (p, "\"dataWindow\":{\"min\":["))) break;
        int x0, y0, x1, y1;
        if (sscanf (p, "%d,%d],\"max\":[%d,%d]", &x0, &y0, &x1, &y1) != 4)
            break;
        const char* chans = find_after (p, "\"channels\":[");
        const char* attrs = chans ? strstr (chans, "\"attributes\":") : NULL;
        if (!chans || !attrs) break;

        int nch = 0;
        for (const char* q = chans; q && q < attrs;
             q  = strstr (q + 1, "{\"name\":"))
            if (*q == '{') ++nch;

        const int w = x1 - x0 + 1, h = y1 - y0 + 1;
        printf (
            "\npart %d: %dx%d, %d channels%s\n",
            part,
            w,
            h,
            nch,
            deep ? " (deep, flattened)" : "");

        /* Deep parts get the sample-count pseudo channel appended. */
        int      nout = nch + (deep ? 1 : 0);
        int32_t* idx  = (int32_t*) malloc (sizeof (int32_t) * (size_t) nout);
        float*   out =
            (float*) malloc (sizeof (float) * (size_t) nout * (size_t) w * h);
        for (int c = 0; c < nch; ++c)
            idx[c] = c;
        if (deep) idx[nch] = EXRV_SAMPLE_COUNT_CHANNEL;

        clock_t t0 = clock ();
        int     rv = exrv_decode_channels (f, part, idx, nout, out);
        double  ms = 1000.0 * (double) (clock () - t0) / CLOCKS_PER_SEC;
        if (rv)
        {
            printf ("  decode failed: %s\n", exrv_last_error ());
            status = 1;
        }
        else
        {
            printf ("  decoded in %.1f ms\n", ms);
            const char* q = chans;
            for (int c = 0; c < nout; ++c)
            {
                int nl = 0;
                if (c < nch)
                {
                    q  = find_after (q, "{\"name\":\"");
                    nl = (int) (strchr (q, '"') - q);
                }
                const char* label = c < nch ? q : "(sample count)";

                const float* pl  = out + (size_t) c * w * h;
                double       mn = INFINITY, mx = -INFINITY, sum = 0;
                size_t       nonfinite = 0;
                for (size_t i = 0; i < (size_t) w * h; ++i)
                {
                    float v = pl[i];
                    if (!isfinite (v))
                    {
                        ++nonfinite;
                        continue;
                    }
                    if (v < mn) mn = v;
                    if (v > mx) mx = v;
                    sum += v;
                }
                printf (
                    "  %-24.*s min %-12g max %-12g mean %-12g%s\n",
                    c < nch ? nl : 14,
                    label,
                    mn,
                    mx,
                    sum / (double) ((size_t) w * h - nonfinite),
                    nonfinite ? " (has NaN/Inf)" : "");
            }
        }
        free (idx);
        free (out);
        p = attrs;
    }

    exrv_close (f);
    return status;
}
