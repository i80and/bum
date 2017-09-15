INSECURE?=0
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

FFMPEG_LIBS=libavutil libavformat libavcodec libswresample libswscale
LIBS=-lz -lm -ljpeg `pkg-config --libs ${FFMPEG_LIBS}`
CFLAGS=-std=c99 -Wall -Wextra -Wshadow -Wno-unused-parameter ${OPT_FLAG} `pkg-config --cflags ${FFMPEG_LIBS}`

.PHONY: clean lint

build/bum-transcode: src/*.c src/*.h
	gcc -o $@ $(CFLAGS) src/main.c $(LIBS) ${INSECURE_FLAG} -flto

clean:
	-rm -r build/*

lint:
	cppcheck --enable=all --inconclusive src/*.c
