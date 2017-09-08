INSECURE?=0

ifeq ($(INSECURE), 1)
	INSECURE_FLAG=-DINSECURE
endif

ifeq ($(DEBUG), 1)
	OPT_FLAG=-O1 -g
else
	OPT_FLAG=-O2
endif

FFMPEG_LIBS=libavutil libavformat libavcodec libswresample
LIBS=-lz -lm `pkg-config --libs ${FFMPEG_LIBS}`
CFLAGS=-std=c99 -Wall -Wextra -Wshadow -Wno-unused-parameter ${OPT_FLAG} `pkg-config --cflags ${FFMPEG_LIBS}`

.PHONY: clean lint

build/bum-transcode: src/main.c
	gcc -o $@ $(CFLAGS) src/main.c $(LIBS) ${INSECURE_FLAG}

clean:
	-rm -r build/*

lint:
	cppcheck --enable=all --inconclusive src/*.c
