#include <stdlib.h>
#include <fileref.h>
#include <tag.h>
#include <tpropertymap.h>

extern "C" {

struct field {
    char* key;
    char* value;
};

struct properties {
    size_t n_fields;
    struct field* fields;
};

properties* taglib_open(const char* path) {
    TagLib::FileRef f(path);
    if(f.isNull() || !f.tag()) { return nullptr; }

    TagLib::PropertyMap tags = f.file()->properties();
    const unsigned int size = tags.size();

    struct properties* properties = reinterpret_cast<struct properties*>(malloc(sizeof(struct properties)));
    properties->n_fields = size;
    properties->fields = reinterpret_cast<struct field*>(calloc(size, sizeof(field)));

    unsigned int i = 0;
    for(TagLib::PropertyMap::ConstIterator it = tags.begin(); it != tags.end(); ++it) {
        for(TagLib::StringList::ConstIterator j = it->second.begin(); j != it->second.end(); ++j) {
            if(i > size) { goto done; }

            field* field = &properties->fields[i];
            field->key = strdup(it->first.to8Bit(true).c_str());
            field->value = strdup(j->to8Bit(true).c_str());
            i += 1;
        }
    }

done:
    if(i < size) { properties->n_fields = size; }
    return properties;
}

void taglib_free(properties* self) {
    for(size_t i = 0; i < self->n_fields; i += 1) {
        free(self->fields[i].key);
        free(self->fields[i].value);
    }

    free(self->fields);
    free(self);
}

}
