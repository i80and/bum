#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include <gst/gst.h>

static inline void __fail(const char* file, int line, const char* func) {
    fprintf(stderr, "%s:%d (%s): Assertion failed\n", file, line, func);
    exit(1);
}

#define assert(cond) ((cond)? (0) : __fail(__FILE__, __LINE__, __func__))

#define QUALITY_LOW 0
// Music: -q2

#define QUALITY_MED 1
// Music: -q4

#define QUALITY_HIGH 2
// Music: -q6

#define QUALITY_RAW 3

const float MUSIC_QUALITIES[] = { 0.2f, 0.4f, 0.6f };
const unsigned int VIDEO_QUALITIES[] = { 500, 1000, 2000 };

const char* MUSIC_PIPELINE = \
    "fdsrc name=src ! decodebin ! audioconvert name=converter ! "
    "vorbisenc name=enc ! webmmux writing-app=bum ! fdsink name=sink";

const char* VIDEO_RT_PIPELINE = \
    "fdsrc name=src ! decodebin name=decode " \
    "mp4mux name=mux ! fdsink name=sink " \
    "decode. ! queue ! videoconvert ! queue ! x264enc name=video-enc ! mux. " \
    "decode. ! queue ! audioconvert ! lamemp3enc name=audio-enc quality=6 ! mux. ";

// GStreamer event filter that removes any image metadata.
static gboolean remove_image(GstPad* pad,
                            GstObject* parent,
                            GstEvent* event) {
    GstTagList* tags = NULL;
    GstPad* sink = NULL;
    gboolean ret = false;

    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_TAG:
            gst_event_parse_tag(event, &tags);
            gst_tag_list_remove_tag(tags, "image");
            event = gst_event_new_tag(tags);
            break;
        case GST_EVENT_CAPS:
            sink = gst_element_get_static_pad(GST_ELEMENT(parent), "src");
            ret = gst_pad_push_event(sink, event);
            gst_object_unref(sink);
            return ret;
        default:
            break;
    }

    return gst_pad_event_default(pad, parent, event);
}

static gboolean bus_call(GstBus* bus, GstMessage* msg, void* data) {
    GMainLoop* loop = (GMainLoop*) data;

    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_EOS:
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
    assert(quality >= 0 && (unsigned int)quality < QUALITY_RAW);

    // Raw not supported yet
    if(quality == QUALITY_RAW) { quality = 2; }

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
    GstElement* converter = gst_bin_get_by_name(GST_BIN(pipeline), "converter");
    GstPad* converter_sink = gst_element_get_static_pad(converter, "sink");
    GstElement* enc = gst_bin_get_by_name(GST_BIN(pipeline), "enc");
    GstElement* sink = gst_bin_get_by_name(GST_BIN(pipeline), "sink");

    if(src == NULL || converter == NULL || enc == NULL || sink == NULL) {
        fprintf(stderr, "Failed to select gstreamer elements\n");
        return 1;
    }

    if(converter_sink == NULL) {
        fprintf(stderr, "Failed to select converter sink\n");
        return 1;
    }

    g_object_set(G_OBJECT(src), "fd", infd, NULL);
    g_object_set(G_OBJECT(enc), "quality", MUSIC_QUALITIES[quality], NULL);
    g_object_set(G_OBJECT(sink), "fd", 1, NULL);

    GMainLoop* loop = g_main_loop_new(NULL, false);
    GstBus* bus = gst_pipeline_get_bus(GST_PIPELINE(pipeline));
    gst_bus_add_watch(bus, bus_call, loop);
    gst_object_unref(bus);

    // We have to remove any image tags. They're unnecessary, and can cause
    // libvorbis to crash.
    gst_pad_set_event_function(converter_sink, remove_image);
    gst_object_unref(converter_sink);

    gst_element_set_state(pipeline, GST_STATE_PLAYING);
    g_main_loop_run(loop);
    gst_element_set_state(pipeline, GST_STATE_NULL);

    return 0;
}

// quality MUST be within the range of [0-3]
// quality=3 indicates that the original payload can be sent
int transcode_video(int infd, int quality) {
    assert(quality >= 0 && (unsigned int)quality < QUALITY_RAW);

    // Raw not supported yet
    if(quality == QUALITY_RAW) { quality = 2; }

    GError* error = NULL;
    GstElement* pipeline = gst_parse_launch(VIDEO_RT_PIPELINE, &error);
    if(error != NULL) {
        fprintf(stderr, "Failed to initialize gstreamer pipeline: %s\n", error->message);
        return 1;
    }

    if(pipeline == NULL) {
        fprintf(stderr, "Failed to initialize gstreamer pipeline\n");
        return 1;
    }

    GstElement* src = gst_bin_get_by_name(GST_BIN(pipeline), "src");
    GstElement* scale = gst_bin_get_by_name(GST_BIN(pipeline), "scale");
    GstElement* video_enc = gst_bin_get_by_name(GST_BIN(pipeline), "video-enc");
    GstElement* sink = gst_bin_get_by_name(GST_BIN(pipeline), "sink");

    if(src == NULL || scale == NULL || video_enc == NULL || sink == NULL) {
        fprintf(stderr, "Failed to select gstreamer elements\n");
        return 1;
    }

    g_object_set(G_OBJECT(src), "fd", infd, NULL);
    g_object_set(G_OBJECT(video_enc), "bitrate", VIDEO_QUALITIES[quality], NULL);
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

void transcode_init(void) {
    gst_init(NULL, NULL);
}
