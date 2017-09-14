INSECURE?=0
SSE?=1
DEBUG?=0

ifeq ($(INSECURE), 1)
	INSECURE_FLAG=-DINSECURE
$(info sandboxing: ON)
else
$(info sandboxing: OFF)
endif

ifeq ($(DEBUG), 1)
	OPT_FLAG=-O1 -g
$(info debugging:  ON)
else
	OPT_FLAG=-O2
$(info debugging:  OFF)
endif

ifeq ($(SSE), 1)
	BLAKE2B=sse
$(info SSE:        ON)
else
	BLAKE2B=ref
$(info SSE:        OFF)
endif

FFMPEG_LIBS=libavutil libavformat libavcodec libswresample libswscale
LIBS=-lz -lm -ljpeg `pkg-config --libs ${FFMPEG_LIBS}`
CFLAGS=-std=c99 -Wall -Wextra -Wshadow -Wno-unused-parameter ${OPT_FLAG} -I src/blake2/${BLAKE2B} `pkg-config --cflags ${FFMPEG_LIBS}`

.PHONY: clean lint

build/bum-transcode: src/*.c src/*.h src/blake2/${BLAKE2B}/*
	gcc -o $@ $(CFLAGS) src/main.c src/blake2/${BLAKE2B}/blake2b.c $(LIBS) ${INSECURE_FLAG}

clean:
	-rm -r build/*

lint:
	cppcheck --enable=all --inconclusive src/*.c
