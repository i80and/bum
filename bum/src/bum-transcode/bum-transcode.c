#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include <gst/gst.h>

#define QUALITY_LOW 0
// Music: -q2

#define QUALITY_MED 1
// Music: -q4

#define QUALITY_HIGH 2
// Music: -q6

static inline void __fail(const char* file, int line, const char* func) {
    fprintf(stderr, "%s:%d (%s): Assertion failed\n", file, line, func);
    exit(1);
}

#define assert(cond) ((cond)? (0) : __fail(__FILE__, __LINE__, __func__))

const float MUSIC_QUALITIES[] = { 0.2f, 0.4f, 0.6f };

const char* MUSIC_PIPELINE = \
    "fdsrc name=src ! decodebin ! audioconvert ! vorbisenc name=enc ! "
    "webmmux writing-app=bum ! fdsink name=sink";

const char* VIDEO_PIPELINE = \
    "fdsrc name=src ! decodebin name=decode "
    "webmmux writing-app=bum name=mux ! fdsink name=sink "
    "decode. ! videoconvert ! vp8enc name=video-enc ! queue ! mux. "
    "decode. ! audioconvert ! vorbisenc name=audio-enc ! queue ! mux. ";

static gboolean bus_call(GstBus *bus, GstMessage *msg, void* data) {
    GMainLoop* loop = (GMainLoop *) data;

    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
            g_print("End of stream\n");
            g_main_loop_quit(loop);
            break;

        case GST_MESSAGE_ERROR: {
            char* debug;
            GError* error;

            gst_message_parse_error(msg, &error, &debug);
            g_free(debug);

            g_printerr("Error: %s\n", error->message);
            g_error_free(error);

            g_main_loop_quit(loop);
            break;
        }
        default:
            break;
    }

    return true;
}

// quality MUST be within the range of [0-2]
int transcode_music(int infd, int quality) {
    assert(quality >= 0 && (unsigned int)quality < sizeof(MUSIC_QUALITIES));

    GError* error = NULL;
    GstElement* pipeline = gst_parse_launch(MUSIC_PIPELINE, &error);
    if(error != NULL) {
        fprintf(stderr, "Failed to initialize gstreamer pipeline: %s\n", error->message);
        return 1;
    }

    if(pipeline == NULL) {
        fprintf(stderr, "Failed to initialize gstreamer plugin");
        return 1;
    }

    GstElement* src = gst_bin_get_by_name(GST_BIN(pipeline), "src");
    GstElement* enc = gst_bin_get_by_name(GST_BIN(pipeline), "enc");
    GstElement* sink = gst_bin_get_by_name(GST_BIN(pipeline), "sink");

    if(src == NULL || enc == NULL || sink == NULL) {
        fprintf(stderr, "Failed to select gstreamer elements\n");
        return 1;
    }

    g_object_set(G_OBJECT(src), "fd", infd, NULL);
    g_object_set(G_OBJECT(enc), "quality", MUSIC_QUALITIES[quality], NULL);
    g_object_set(G_OBJECT(sink), "fd", 1, NULL);

    GMainLoop* loop = g_main_loop_new(NULL, false);
    GstBus* bus = gst_pipeline_get_bus(GST_PIPELINE(pipeline));
    gst_bus_add_watch(bus, bus_call, loop);
    gst_object_unref(bus);

    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    g_main_loop_run(loop);
    gst_element_set_state(pipeline, GST_STATE_NULL);

    return 0;
}

int transcode_video(int infd, int quality) {
    GError* error = NULL;
    GstElement* pipeline = gst_parse_launch(VIDEO_PIPELINE, &error);
    if(error != NULL) {
        fprintf(stderr, "Failed to initialize gstreamer pipeline: %s\n", error->message);
        return 1;
    }

    if(pipeline == NULL) {
        fprintf(stderr, "Failed to initialize gstreamer pipeline\n");
        return 1;
    }

    return 0;
}

void transcode_init(void) {
    gst_init(NULL, NULL);
}
