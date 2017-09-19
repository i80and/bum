SANDBOX?=1
DEBUG?=0

ifeq ($(SANDBOX), 1)
$(info sandboxing: ON)
else
	INSECURE_FLAG=-DINSECURE
$(info sandboxing: OFF)
endif

ifeq ($(DEBUG), 1)
	OPT_FLAG=-O1 -g
$(info debugging:  ON)
else
	OPT_FLAG=-O2
$(info debugging:  OFF)
endif

FFMPEG_LIBS=libavutil libavformat libavcodec libswscale libavfilter
LIBS=-lz -lm -ljpeg `pkg-config --libs ${FFMPEG_LIBS}`
CFLAGS=-std=c99 -Wall -Wextra -Wshadow -Wno-unused-parameter ${OPT_FLAG} `pkg-config --cflags ${FFMPEG_LIBS}`

.PHONY: clean lint

build/bum-transcode: src/*.c src/*.h
	$(CC) -o $@ $(CFLAGS) src/main.c $(LIBS) ${INSECURE_FLAG}

clean:
	-rm -r build/*

lint:
	cppcheck --enable=all --inconclusive src/*.c
