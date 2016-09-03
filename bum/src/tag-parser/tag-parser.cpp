#include <stdlib.h>
#include <string.h>
#include <fileref.h>
#include <tag.h>
#include <tpropertymap.h>
#include <attachedpictureframe.h>
#include <id3v2tag.h>
#include <mpegfile.h>

extern "C" {

struct Field {
    char* key;
    char* value;
};

struct Properties {
    size_t n_fields;
    Field* fields;
};

struct Image {
    char* mimeType;
    char* data;
    size_t len;

private:
    Image(const Image&);
};

static int taglib_get_cover_id3v2(TagLib::MPEG::File* file, Image* out);

Properties* taglib_open(const char* path) {
    TagLib::FileRef f(path);
    if(f.isNull() || !f.tag()) { return NULL; }

    TagLib::PropertyMap tags = f.file()->properties();
    const unsigned int size = tags.size();

    Properties* properties = reinterpret_cast<Properties*>(calloc(1, sizeof(Properties)));
    properties->n_fields = size;
    properties->fields = reinterpret_cast<Field*>(calloc(size, sizeof(Field)));

    unsigned int i = 0;
    for(TagLib::PropertyMap::ConstIterator it = tags.begin(); it != tags.end(); ++it) {
        for(TagLib::StringList::ConstIterator j = it->second.begin(); j != it->second.end(); ++j) {
            if(i > size) { goto done; }

            Field* field = &properties->fields[i];
            field->key = strdup(it->first.to8Bit(true).c_str());
            field->value = strdup(j->to8Bit(true).c_str());
            i += 1;
        }
    }

done:
    if(i < size) { properties->n_fields = size; }
    return properties;
}

int taglib_get_cover(const char* path, Image* out) {
    TagLib::FileRef wrapper_file(path);
    if(wrapper_file.isNull() || !wrapper_file.tag()) {
        return 1;
    }

    TagLib::MPEG::File* file = dynamic_cast<TagLib::MPEG::File*>(wrapper_file.file());
    if(file != NULL && file->hasID3v2Tag()) {
        return taglib_get_cover_id3v2(file, out);
    }

    return 1;
}

void taglib_image_free(Image* image) {
    free(image->mimeType);
    free(image->data);
}

void taglib_free(Properties* self) {
    for(size_t i = 0; i < self->n_fields; i += 1) {
        free(self->fields[i].key);
        free(self->fields[i].value);
    }

    free(self->fields);
    free(self);
}

static int taglib_get_cover_id3v2(TagLib::MPEG::File* file, Image* out) {
    TagLib::ID3v2::Tag* tag = file->ID3v2Tag();
    TagLib::ID3v2::FrameList frames = tag->frameList("APIC");

    if(frames.isEmpty()) {
        return 1;
    }

    TagLib::ID3v2::AttachedPictureFrame* frame =
        static_cast<TagLib::ID3v2::AttachedPictureFrame*>(frames.front());

    TagLib::ByteVector picture = frame->picture();
    char* buf = reinterpret_cast<char*>(malloc(picture.size()));
    memcpy(buf, picture.data(), picture.size());

    out->mimeType = strdup(frame->mimeType().toCString(true));
    out->data = buf;
    out->len = picture.size();
    return 0;
}

}
