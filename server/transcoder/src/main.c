#include <errno.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>

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

#define OUTPUT_BITRATE 128000
#define OUTPUT_SAMPLE_RATE 48000
#define OUTPUT_CHANNEL_LAYOUT AV_CH_LAYOUT_STEREO

typedef struct {
    AVFrame* resampled_frame;
    AVCodecContext* encode_context;
    SwrContext* swr;
    AVFormatContext* output_format_context;

    AVRational input_time_base;
    AVRational output_time_base;
} TranscodeContext;

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
            cb(priv, frame);
        }
    }

    av_frame_free(&frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        return 0;
    }

    return ret;
}

static int64_t pts = 0;

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

    // Some containers (e.g. WAV) only provide channel count, not layout
    if (!frame->channel_layout) {
        frame->channel_layout = av_get_default_channel_layout(frame->channels);
    }

    if (ctx->swr == NULL) {
        // Prepare the resampler. Do this lazily, since some container formats
        // only provide the necessary information with the first packet.
        SwrContext* swr = swr_alloc();
        verify(swr != NULL);
        verify_ffmpeg(swr_config_frame(swr, ctx->resampled_frame, frame));
        verify_ffmpeg(swr_init(swr));
        ctx->swr = swr;
    }

    verify_ffmpeg(swr_convert_frame(ctx->swr, NULL, frame));

    while (swr_get_delay(ctx->swr, frame->sample_rate) >= ctx->encode_context->frame_size) {
        ctx->resampled_frame->pts = pts;
        verify_ffmpeg(swr_convert_frame(ctx->swr, ctx->resampled_frame, NULL));
        verify_ffmpeg(encode(ctx->encode_context, ctx->resampled_frame, handle_encoded, ctx));
        pts += ctx->resampled_frame->nb_samples;
    }

    return 0;
}

int transcode_audio(char* path, _Bool verbose) {
    av_register_all();

    AVFormatContext* decode_format = NULL;

    // Register all formats and codecs
    av_register_all();

    // Open input file
    verify_ffmpeg(avformat_open_input(&decode_format, path, NULL, NULL));

    // Retrieve stream information
    verify(avformat_find_stream_info(decode_format, NULL) >= 0);

    if (verbose) {
        // Dump information about file onto standard error
        av_dump_format(decode_format, 0, path, 0);
    }

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
    AVOutputFormat* output_format = av_guess_format("matroska", NULL, NULL);
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
    encode_context->sample_fmt = AV_SAMPLE_FMT_S16;
    encode_context->bit_rate = OUTPUT_BITRATE;
    encode_context->sample_rate = OUTPUT_SAMPLE_RATE;
    encode_context->channel_layout = OUTPUT_CHANNEL_LAYOUT;

    // Open codecs
    verify_ffmpeg(avcodec_open2(decode_context, decode_codec, NULL));
    verify_ffmpeg(avcodec_open2(encode_context, encode_codec, NULL));

    TranscodeContext ctx;
    ctx.encode_context = encode_context;
    ctx.output_format_context = output_format_context;
    ctx.swr = NULL;

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

    ctx.input_time_base = input_stream->time_base;
    ctx.output_time_base = output_stream->time_base;

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

    if (ctx.swr != NULL) {
        swr_free(&ctx.swr);
    }

    return 0;
}

int main(int argc, char** argv) {
    verify_warn(pledge("stdio rpath", NULL) == 0);

    if (argc > 1) {
        return transcode_audio(argv[1], 0);
    }
}
