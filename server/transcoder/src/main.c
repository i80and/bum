#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavfilter/avfilter.h>
#include <libavfilter/buffersink.h>
#include <libavfilter/buffersrc.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>

#include <jpeglib.h>

#include "util.h"

#define OUTPUT_BITRATE 128000
#define OUTPUT_SAMPLE_RATE 48000
#define OUTPUT_CHANNEL_LAYOUT AV_CH_LAYOUT_STEREO
#define OUTPUT_SAMPLE_FORMAT AV_SAMPLE_FMT_S16
#define THUMBNAIL_SIZE 200
#define HASH_LENGTH 16

#define STOP_AND_YIELD_FRAME (int)MKTAG('f', 'r', 'a', 'm')

typedef struct {
    AVFrame* resampled_frame;
    AVCodecContext* encode_context;
    AVFormatContext* output_format_context;

    AVRational input_time_base;
    AVRational output_time_base;

    AVFilterGraph* filter_graph;
    AVFilterContext* buffersrc_ctx;
    AVFilterContext* buffersink_ctx;
} TranscodeContext;

typedef struct {
    AVFrame* frame;
} CoverDecodeContext;

// return 0 on success, negative on error
typedef int (*decode_frame_cb)(void* ctx, AVFrame* frame);
typedef int (*encode_packet_cb)(void* ctx, AVPacket* pkt);

int decode(AVCodecContext* avctx, const AVPacket* pkt,
           decode_frame_cb cb, void* priv) {
    AVFrame* frame = av_frame_alloc();
    int ret = 0;

    ret = avcodec_send_packet(avctx, pkt);
    if (ret < 0 && ret != AVERROR_EOF) {
        verify_ffmpeg(ret);
    }

    while (ret == 0) {
        ret = avcodec_receive_frame(avctx, frame);
        if (ret < 0 && ret != AVERROR(EAGAIN)) {
            verify_ffmpeg(ret);
        }

        if (ret == 0) {
            ret = cb(priv, frame);
        }

        if (ret == STOP_AND_YIELD_FRAME) {
            break;
        }
    }

    if (ret != STOP_AND_YIELD_FRAME) {
        av_frame_free(&frame);
    }

    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF || ret == STOP_AND_YIELD_FRAME) {
        return 0;
    }

    return ret;
}

int encode(AVCodecContext* avctx, const AVFrame* frame,
           encode_packet_cb cb, void* priv) {
    AVPacket pkt;
    pkt.data = NULL;
    pkt.size = 0;
    av_init_packet(&pkt);

    verify_ffmpeg(avcodec_send_frame(avctx, frame));

    int ret = 0;
    do {
        ret = avcodec_receive_packet(avctx, &pkt);
        if (ret >= 0) {
            cb(priv, &pkt);
            av_packet_unref(&pkt);
        } else if (ret < 0 && ret != AVERROR(EAGAIN) && ret != AVERROR_EOF) {
            return ret;
        }
    } while (ret >= 0);

    return 0;
}

int handle_encoded(void* raw_ctx, AVPacket* pkt) {
    TranscodeContext* ctx = (TranscodeContext*)raw_ctx;
    av_packet_rescale_ts(pkt, ctx->input_time_base, ctx->output_time_base);
    verify_ffmpeg(av_interleaved_write_frame(ctx->output_format_context, pkt));
    return 0;
}

int handle_decoded(void* raw_ctx, AVFrame* frame) {
    TranscodeContext* ctx = (TranscodeContext*)raw_ctx;

    verify_ffmpeg(av_buffersrc_add_frame_flags(ctx->buffersrc_ctx, frame, AV_BUFFERSRC_FLAG_KEEP_REF));

    while (true) {
        AVFrame* resampled_frame = av_frame_alloc();
        int ret = av_buffersink_get_frame(ctx->buffersink_ctx, resampled_frame);

        if (ret == AVERROR(EAGAIN)) {
            av_frame_unref(frame);
            av_frame_unref(resampled_frame);
            return 0;
        }

        verify_ffmpeg(ret);
        verify_ffmpeg(encode(ctx->encode_context, resampled_frame, handle_encoded, ctx));
        av_frame_unref(frame);
        av_frame_unref(resampled_frame);
    }

    return 0;
}

int handle_decoded_cover(void* raw_ctx, AVFrame* frame) {
    CoverDecodeContext* ctx = (CoverDecodeContext*)raw_ctx;
    ctx->frame = frame;

    return STOP_AND_YIELD_FRAME;
}

const char* filter_description = "aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,asetnsamples=n=960:p=0";
int initialize_audio_filter(const AVStream* inputStream, TranscodeContext* ctx) {
    char args[512];

    avfilter_register_all();

    const AVFilter* buffersrc = avfilter_get_by_name("abuffer");
    const AVFilter* buffersink = avfilter_get_by_name("abuffersink");
    AVFilterInOut* outputs = avfilter_inout_alloc();
    AVFilterInOut* inputs = avfilter_inout_alloc();
    ctx->filter_graph = avfilter_graph_alloc();

    verify(buffersrc != NULL);
    verify(buffersink != NULL);
    verify(outputs != NULL);
    verify(inputs != NULL);
    verify(ctx->filter_graph != NULL);

    const enum AVSampleFormat out_sample_fmts[] = {OUTPUT_SAMPLE_FORMAT, AV_SAMPLE_FMT_NONE};
    const int64_t out_channel_layouts[] = {OUTPUT_CHANNEL_LAYOUT, -1};
    const int out_sample_rates[] = {OUTPUT_SAMPLE_RATE, -1};

    snprintf(args, sizeof(args), "time_base=%d/%d:sample_rate=%d:sample_fmt=%s:channel_layout=0x%" PRIx64,
        inputStream->time_base.num, inputStream->time_base.den,
        inputStream->codecpar->sample_rate,
        av_get_sample_fmt_name(inputStream->codecpar->format),
        inputStream->codecpar->channel_layout);
    verify_ffmpeg(avfilter_graph_create_filter(&ctx->buffersrc_ctx, buffersrc, "in", args, NULL, ctx->filter_graph));
    verify_ffmpeg(avfilter_graph_create_filter(&ctx->buffersink_ctx, buffersink, "out", NULL, NULL, ctx->filter_graph));
    verify_ffmpeg(av_opt_set_int_list(ctx->buffersink_ctx, "sample_fmts", out_sample_fmts, -1, AV_OPT_SEARCH_CHILDREN));
    verify_ffmpeg(av_opt_set_int_list(ctx->buffersink_ctx, "channel_layouts", out_channel_layouts, -1, AV_OPT_SEARCH_CHILDREN));
    verify_ffmpeg(av_opt_set_int_list(ctx->buffersink_ctx, "sample_rates", out_sample_rates, -1, AV_OPT_SEARCH_CHILDREN));

    // Endpoints for the filter graph. */
    outputs->name = av_strdup("in");
    outputs->filter_ctx = ctx->buffersrc_ctx;
    outputs->pad_idx = 0;
    outputs->next = NULL;

    inputs->name = av_strdup("out");
    inputs->filter_ctx = ctx->buffersink_ctx;
    inputs->pad_idx = 0;
    inputs->next = NULL;

    int ret = avfilter_graph_parse_ptr(ctx->filter_graph, filter_description, &inputs, &outputs, NULL);
    if (ret < 0) { verify_ffmpeg(ret); }

    verify_ffmpeg(avfilter_graph_config(ctx->filter_graph, NULL));

    AVFilterLink* outlink = ctx->buffersink_ctx->inputs[0];
    av_get_channel_layout_string(args, sizeof(args), -1, outlink->channel_layout);

    return 0;
}

int transcode_audio(char* path) {
    AVFormatContext* decode_format = NULL;

    // Open input file
    verify_ffmpeg(avformat_open_input(&decode_format, path, NULL, NULL));

    // Retrieve stream information
    verify(avformat_find_stream_info(decode_format, NULL) >= 0);

    // Find the first audio stream
    int audio_stream = -1;
    for(uint32_t i = 0; i < decode_format->nb_streams; i++) {
        if(decode_format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            audio_stream = i;
            break;
        }
    }

    verify(audio_stream != -1);

    // Find the decoder for the stream
    const AVStream* input_stream = decode_format->streams[audio_stream];
    const AVCodecParameters* codecpar = input_stream->codecpar;
    AVCodec* decode_codec = avcodec_find_decoder(codecpar->codec_id);
    if(decode_codec == NULL) {
        fprintf(stderr, "Unsupported codec\n");
        return 1;
    }

    const AVCodec* encode_codec = avcodec_find_encoder(AV_CODEC_ID_OPUS);
    if (encode_codec == NULL) {
        fprintf(stderr, "Opus encoding not supported\n");
        return 1;
    }

    // Open our I/O handler
    AVIOContext* output_io_context = NULL;
    verify_ffmpeg(avio_open(&output_io_context, "pipe:1", AVIO_FLAG_WRITE));

    // Open muxer
    AVFormatContext* output_format_context = avformat_alloc_context();
    verify(output_format_context != NULL);
    AVOutputFormat* output_format = av_guess_format("webm", NULL, NULL);
    verify(output_format != NULL);
    AVStream* output_stream = avformat_new_stream(output_format_context, encode_codec);
    verify(output_stream != NULL);
    output_format_context->duration = decode_format->duration;
    output_format_context->pb = output_io_context;
    output_format_context->oformat = output_format;

    // Set up codec contexts
    AVCodecContext* decode_context = avcodec_alloc_context3(decode_codec);
    verify(!avcodec_parameters_to_context(decode_context, codecpar));
    av_codec_set_pkt_timebase(decode_context, input_stream->time_base);

    AVCodecContext* encode_context = avcodec_alloc_context3(encode_codec);
    verify(encode_context != NULL);
    encode_context->sample_fmt = OUTPUT_SAMPLE_FORMAT;
    encode_context->bit_rate = OUTPUT_BITRATE;
    encode_context->sample_rate = OUTPUT_SAMPLE_RATE;
    encode_context->channel_layout = OUTPUT_CHANNEL_LAYOUT;

    // Open codecs
    verify_ffmpeg(avcodec_open2(decode_context, decode_codec, NULL));
    verify_ffmpeg(avcodec_open2(encode_context, encode_codec, NULL));

    TranscodeContext ctx;
    ctx.encode_context = encode_context;
    ctx.output_format_context = output_format_context;

    // Setup our encoding frame
    ctx.resampled_frame = av_frame_alloc();
    ctx.resampled_frame->channel_layout = encode_context->channel_layout;
    ctx.resampled_frame->sample_rate = encode_context->sample_rate;
    ctx.resampled_frame->format = encode_context->sample_fmt;
    ctx.resampled_frame->nb_samples = encode_context->frame_size;
    verify_ffmpeg(av_frame_get_buffer(ctx.resampled_frame, 0));

    verify_ffmpeg(avcodec_parameters_from_context(output_stream->codecpar, encode_context));
    output_stream->time_base.den = encode_context->sample_rate;
    output_stream->time_base.num = 1;
    verify_ffmpeg(avformat_write_header(ctx.output_format_context, NULL));

    // I... don't understand why this garbage is necessary?
    ctx.input_time_base = input_stream->time_base;
    ctx.input_time_base.den = OUTPUT_SAMPLE_RATE;
    ctx.output_time_base = output_stream->time_base;
    initialize_audio_filter(input_stream, &ctx);

    // Transcode loop
    while(1) {
        AVPacket decode_packet;
        int ret = av_read_frame(decode_format, &decode_packet);
        if (ret == AVERROR(EAGAIN)) {
            sleep(1);
            continue;
        }

        if (ret == AVERROR_EOF) {
            break;
        }

        verify_ffmpeg(ret);

        if(decode_packet.stream_index != audio_stream) {
            goto next;
        }

        verify_ffmpeg(decode(decode_context, &decode_packet, handle_decoded, &ctx));

next:
        av_packet_unref(&decode_packet);
    }

    // Flush the encoder
    verify(encode(encode_context, NULL, handle_encoded, &ctx) == 0);

    // Finish writing the output stream
    verify_ffmpeg(av_write_trailer(ctx.output_format_context));

    avio_closep(&output_io_context);
    av_frame_free(&ctx.resampled_frame);
    avcodec_close(decode_context);
    avcodec_close(encode_context);
    avformat_free_context(output_format_context);
    avformat_close_input(&decode_format);

    return 0;
}

int get_cover(const char* path, AVFrame** out_frame) {
    AVFormatContext* decode_format = NULL;
    AVCodecContext* decode_context = NULL;
    int ret = 0;

    ret = avformat_open_input(&decode_format, path, NULL, NULL);
    if (ret < 0) { goto cleanup; }

    ret = avformat_find_stream_info(decode_format, NULL);
    if (ret < 0) { goto cleanup; }

    // Find an image stream
    int cover_stream = -1;
    for(uint32_t i = 0; i < decode_format->nb_streams; i++) {
        if(decode_format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_VIDEO) {
            cover_stream = i;
            break;
        }
    }

    if (cover_stream == -1) {
        ret = 1;
        goto cleanup;
    }

    const AVStream* input_stream = decode_format->streams[cover_stream];
    const AVCodecParameters* codecpar = input_stream->codecpar;
    AVCodec* decode_codec = avcodec_find_decoder(codecpar->codec_id);
    if(decode_codec == NULL) {
        ret = 1;
        goto cleanup;
    }

    decode_context = avcodec_alloc_context3(decode_codec);
    ret = avcodec_parameters_to_context(decode_context, codecpar);
    if (ret < 0) { goto cleanup; }
    ret = avcodec_open2(decode_context, decode_codec, NULL);
    if (ret < 0) { goto cleanup; }

    CoverDecodeContext ctx;
    ctx.frame = NULL;

    while(1) {
        AVPacket decode_packet;
        ret = av_read_frame(decode_format, &decode_packet);
        if (ret == AVERROR(EAGAIN)) {
            sleep(1);
            continue;
        }

        if (ret == AVERROR_EOF) {
            ret = 0;
            break;
        }

        if (ret < 0) {
            goto cleanup;
        }

        if(decode_packet.stream_index != cover_stream) {
            goto next;
        }


        verify_ffmpeg(decode(decode_context, &decode_packet, handle_decoded_cover, &ctx));

next:
        av_packet_unref(&decode_packet);
        if (ctx.frame != NULL) { break; }
    }

cleanup:
    if (decode_context != NULL) {
        avcodec_close(decode_context);
    }

    if (decode_format != NULL) {
        avformat_close_input(&decode_format);
    }

    if (ret == 0) {
        *out_frame = ctx.frame;
    }

    return ret;
}

int get_covers(char* const* paths, int n_paths, bool thumbnail) {
    AVFrame* scaled_frame = NULL;

    struct jpeg_compress_struct jpeg_ctx;
    struct jpeg_error_mgr jpeg_err;
    jpeg_ctx.err = jpeg_std_error(&jpeg_err);
    jpeg_create_compress(&jpeg_ctx);

    for (int i = 0; i < n_paths; i += 1) {
        const char* path = paths[i];
        AVFrame* frame = NULL;
        uint32_t out_size_32 = 0;
        int ret = get_cover(path, &frame);
        if (ret < 0) {
            fprintf(stderr, "%s\n", av_err2str(ret));
            fwrite(&out_size_32, sizeof(out_size_32), 1, stdout);
            continue;
        }

        if (frame == NULL) {
            fwrite(&out_size_32, sizeof(out_size_32), 1, stdout);
            continue;
        }

        int target_width = frame->width;
        int target_height = frame->height;

        if (thumbnail) {
            target_width = THUMBNAIL_SIZE;
            target_height = THUMBNAIL_SIZE;
        }

        scaled_frame = av_frame_alloc();
        verify(scaled_frame != NULL);
        scaled_frame->format = AV_PIX_FMT_RGB24;
        scaled_frame->width = target_width;
        scaled_frame->height = target_height;
        av_image_alloc(scaled_frame->data, scaled_frame->linesize, scaled_frame->width, scaled_frame->height, scaled_frame->format, 32);
        scaled_frame->linesize[0] = target_width * 3;

        struct SwsContext* sws = sws_getContext(frame->width, frame->height, frame->format, scaled_frame->width, scaled_frame->height, scaled_frame->format, SWS_LANCZOS, NULL, NULL, 0);
        verify(sws != NULL);

        sws_scale(sws, (const uint8_t * const*)frame->data, frame->linesize, 0, frame->height, scaled_frame->data, scaled_frame->linesize);
        uint8_t* scaled_buf = scaled_frame->data[0];

        unsigned long out_size = 0;
        uint8_t* out_buf = NULL;

        jpeg_ctx.image_width = scaled_frame->width;
        jpeg_ctx.image_height = scaled_frame->height;
        jpeg_ctx.input_components = 3;
        jpeg_ctx.in_color_space = JCS_RGB;
        jpeg_mem_dest(&jpeg_ctx, &out_buf, &out_size);
        jpeg_set_defaults(&jpeg_ctx);
        jpeg_start_compress(&jpeg_ctx, TRUE);

        JSAMPROW row_pointer[1];
        const int row_stride = jpeg_ctx.image_width * jpeg_ctx.input_components;
        while (jpeg_ctx.next_scanline < jpeg_ctx.image_height) {
            row_pointer[0] = &scaled_buf[jpeg_ctx.next_scanline * row_stride];
            jpeg_write_scanlines(&jpeg_ctx, row_pointer, 1);
        }

        jpeg_finish_compress(&jpeg_ctx);

        out_size_32 = out_size;
        fwrite(&out_size_32, sizeof(out_size_32), 1, stdout);
        fwrite(out_buf, sizeof(uint8_t), out_size_32, stdout);

        free(out_buf);
        sws_freeContext(sws);
        av_frame_free(&frame);
        av_frame_free(&scaled_frame);
    }

    jpeg_destroy_compress(&jpeg_ctx);

    return 0;
}

int main(int argc, char** argv) {
    verify_warn(pledge("stdio rpath", NULL) == 0);
    av_register_all();

    if (argc <= 2) {
        return 1;
    }

    if (strcmp(argv[1], "transcode-audio") == 0) {
        return transcode_audio(argv[2]);
    } else if(strcmp(argv[1], "get-thumbnails") == 0) {
        return get_covers(argv + 2, argc - 2, true);
    } else if(strcmp(argv[1], "get-cover") == 0) {
        return get_covers(argv + 2, min(argc - 2, 1), false);
    }

    return 1;
}
